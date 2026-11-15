import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = {};
const context = vm.createContext({
  self, window: self, console, Date, Math, Map, Set, Object, Array, Number,
  String, Boolean, JSON, Promise, Error, TypeError, Uint8Array
});
vm.runInContext(
  fs.readFileSync(path.join(root, "engine-20261107bb.js"), "utf8"),
  context,
  { filename: "engine-20261107bb.js" }
);

const E = self.GungiEngine;
assert.ok(E, "rules engine should load");

function referenceTargets(state, row, col) {
  const stack = E.getStack(state, row, col);
  if (!stack || !stack.length || stack.length > 3) return [];
  const piece = stack[stack.length - 1];
  const level = stack.length;
  const rule = E.MOVE_RULES[piece.name];
  if (!rule) return [];
  const vectors = [
    ...rule[1],
    ...(level >= 2 ? rule[2] : []),
    ...(level >= 3 ? rule[3] : [])
  ];
  const targets = [];
  const seen = new Set();
  const rotate = (forward, right) =>
    piece.side === "先手" ? [-forward, right] : [forward, right];

  // Deliberately retain the former Set/string implementation as an oracle.
  for (const [forward, right] of vectors) {
    const [dr, dc] = rotate(forward, right);
    const tr = row + dr;
    const tc = col + dc;
    if (!E.isInside(tr, tc)) continue;
    const key = tr + "," + tc;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push({
        row: tr,
        col: tc,
        jump: (rule.jumps || []).some(vector =>
          vector[0] === forward && vector[1] === right
        )
      });
    }
  }

  for (const [forward, right] of (rule.rays || [])) {
    const [dr, dc] = rotate(forward, right);
    let tr = row + dr;
    let tc = col + dc;
    while (E.isInside(tr, tc)) {
      const key = tr + "," + tc;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ row: tr, col: tc, jump: false, ray: true });
      }
      if (E.getTopPiece(state, tr, tc)) break;
      tr += dr;
      tc += dc;
    }
  }
  return targets;
}

function rng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function fixture(pieceName, side, level, sourceRow, sourceCol, seed) {
  const random = rng(seed);
  const state = E.createGameState();
  state.phase = "move";
  state.turn = side;

  for (let layer = 1; layer < level; layer++) {
    state.board[sourceRow][sourceCol].push(
      E.createPiece("兵", side, "base-" + seed + "-" + layer)
    );
  }
  state.board[sourceRow][sourceCol].push(
    E.createPiece(pieceName, side, "source-" + seed)
  );

  const blockers = ["兵", "侍", "槍", "騎", "砦", "大将"];
  let serial = 0;
  for (let row = 0; row < E.SIZE; row++) {
    for (let col = 0; col < E.SIZE; col++) {
      if (row === sourceRow && col === sourceCol) continue;
      if (random() >= 0.13) continue;
      const height = 1 + Math.floor(random() * 3);
      const blockerSide = random() < 0.5 ? "先手" : "後手";
      for (let layer = 0; layer < height; layer++) {
        const name = blockers[Math.floor(random() * blockers.length)];
        state.board[row][col].push(
          E.createPiece(name, blockerSide, "block-" + seed + "-" + serial++)
        );
      }
    }
  }
  return state;
}

let targetCases = 0;
for (const pieceName of Object.keys(E.PIECE_COUNTS)) {
  for (const side of ["先手", "後手"]) {
    for (let level = 1; level <= 3; level++) {
      for (let row = 0; row < E.SIZE; row++) {
        for (let col = 0; col < E.SIZE; col++) {
          const seed = 1 + targetCases * 97;
          const state = fixture(pieceName, side, level, row, col, seed);
          const actual = E.getMovementTargets(state, row, col);
          const expected = referenceTargets(state, row, col);
          assert.equal(
            JSON.stringify(actual),
            JSON.stringify(expected),
            "optimized target generation must preserve the previous output: " +
              [pieceName, side, level, row, col].join("/")
          );
          const unique = new Set(actual.map(target => target.row * E.SIZE + target.col));
          assert.equal(unique.size, actual.length, "a piece must not receive duplicate destination squares");
          targetCases++;
        }
      }
    }
  }
}

function referenceFrontmostRow(state, side) {
  const rows = [];
  for (let row = 0; row < E.SIZE; row++) {
    for (let col = 0; col < E.SIZE; col++) {
      const stack = state.board[row][col];
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.side === side) rows.push(row);
    }
  }
  if (!rows.length) return null;
  return side === "先手" ? Math.min(...rows) : Math.max(...rows);
}

let frontmostCases = 0;
for (let seed = 1; seed <= 500; seed++) {
  const state = E.createGameState();
  const random = rng(seed * 7919);
  for (let row = 0; row < E.SIZE; row++) {
    for (let col = 0; col < E.SIZE; col++) {
      if (random() >= 0.18) continue;
      const height = 1 + Math.floor(random() * 3);
      for (let layer = 0; layer < height; layer++) {
        const side = random() < 0.5 ? "先手" : "後手";
        state.board[row][col].push(
          E.createPiece("兵", side, "front-" + seed + "-" + row + "-" + col + "-" + layer)
        );
      }
    }
  }
  for (const side of ["先手", "後手"]) {
    assert.equal(
      E.getFrontmostFriendlyRow(state, side),
      referenceFrontmostRow(state, side),
      "single-pass frontmost row must match the previous min/max implementation"
    );
    frontmostCases++;
  }
}

let legalMoveCases = 0;
for (let seed = 1; seed <= 250; seed++) {
  const state = E.createGameState();
  const random = rng(seed * 104729);
  state.phase = "move";
  for (let row = 0; row < E.SIZE; row++) {
    for (let col = 0; col < E.SIZE; col++) {
      if (random() >= 0.12) continue;
      const side = random() < 0.5 ? "先手" : "後手";
      const name = ["兵", "侍", "槍", "騎", "砦", "弓", "筒", "砲", "大将"][
        Math.floor(random() * 9)
      ];
      const height = 1 + Math.floor(random() * 3);
      for (let layer = 0; layer < height; layer++) {
        state.board[row][col].push(
          E.createPiece(layer === height - 1 ? name : "兵", side,
            "legal-" + seed + "-" + row + "-" + col + "-" + layer)
        );
      }
    }
  }
  for (const side of ["先手", "後手"]) {
    const moves = E.generateLegalMoves(state, side);
    const keys = new Set();
    for (const move of moves) {
      assert.equal(move.piece.side, side, "only the requested side's top pieces may move");
      assert.equal(
        E.getTopPiece(state, move.from.row, move.from.col).id,
        move.piece.id,
        "a covered piece must never appear as a moving piece"
      );
      assert.ok(E.canMoveTo(state, move.from.row, move.from.col, move.to.row, move.to.col),
        "every generated move must pass the engine's destination validator");
      const key = [move.from.row, move.from.col, move.to.row, move.to.col].join(",");
      assert.ok(!keys.has(key), "legal move list must not contain duplicate source/destination pairs");
      keys.add(key);
    }
    legalMoveCases++;
  }
}

console.log(JSON.stringify({
  success: true,
  targetCases,
  frontmostCases,
  legalMoveCases,
  checks: [
    "optimized movement targets match the former Set-based implementation",
    "jump and ray metadata remain unchanged",
    "ray blockers preserve the previous stopping behavior",
    "movement targets contain no duplicate squares",
    "single-pass frontmost-row scan matches the former min/max implementation",
    "legal moves use only top pieces and contain no duplicate destinations"
  ]
}, null, 2));
