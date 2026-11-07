(() => {
  "use strict";
  const E = window.GungiEngine;
  const state = E.createGameState();
  const boardElement = document.getElementById("board");
  const sideSelect = document.getElementById("side-select");
  const pickerElement = document.getElementById("piece-picker");
  const countElement = document.getElementById("inventory-count");
  const summaryElement = document.getElementById("inventory-summary");
  const messageElement = document.getElementById("message");
  const selectedElement = document.getElementById("selected");
  const infoElement = document.getElementById("cell-info");
  let selected = null;
  let selectedName = "帥";
  let mode = "setup";
  let moveTargets = [];
  let pendingMove = null;
  let actionMode = "move";
  const moveChoiceElement = document.getElementById("move-choice");
  const captureButton = document.getElementById("capture-choice");
  const tsukeButton = document.getElementById("tsuke-choice");
  const checkOverlay = document.getElementById("check-overlay");
  const aiButton = document.getElementById("ai-move");
  let aiThinking = false;
  let checkOverlayTimer = null;
  let checkOverlayFadeTimer = null;
  function showCheck(side) {
    checkOverlay.textContent = "帥手";
    checkOverlay.classList.remove("is-fading");
    checkOverlay.style.transform = side === "後手" ? "translate(-50%, -50%) rotate(180deg)" : "translate(-50%, -50%)";
    checkOverlay.hidden = false;
    if (checkOverlayTimer !== null) clearTimeout(checkOverlayTimer);
    if (checkOverlayFadeTimer !== null) clearTimeout(checkOverlayFadeTimer);
    checkOverlayFadeTimer = setTimeout(() => { checkOverlay.classList.add("is-fading"); checkOverlayFadeTimer = null; }, 1000);
    checkOverlayTimer = setTimeout(() => { checkOverlay.hidden = true; checkOverlay.classList.remove("is-fading"); checkOverlayTimer = null; }, 1500);
  }
  function currentSide() { return mode === "move" ? state.turn : state.setupTurn; }
  function checkNotice(side) { return E.isInCheck(state, side) ? " ・王手" : ""; }
  function piecesInHand(side, name) {
    return state.hands[side].filter(piece => piece.name === name);
  }
  function refreshPiecePicker() {
    const hand = state.hands[currentSide()];
    const names = Object.keys(E.PIECE_COUNTS);
    const hasPlacedAnyPiece = state.history.some(entry => entry.type === "place" && entry.side === currentSide());
    if (mode === "setup" && !hasPlacedAnyPiece) selectedName = "帥";
    if (!hand.some(piece => piece.name === selectedName)) {
      selectedName = names.find(name => hand.some(piece => piece.name === name)) || names[0];
    }
    pickerElement.replaceChildren();
    for (const name of names) {
      const count = piecesInHand(currentSide(), name).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "piece-choice" + (name === selectedName ? " active" : "");
      button.disabled = count === 0 || (mode === "setup" && !hasPlacedAnyPiece && name !== "帥");
      button.textContent = name + " · " + count;
      button.setAttribute("aria-pressed", String(name === selectedName));
      button.addEventListener("click", () => {
        selectedName = name;
        messageElement.textContent = currentSide() + "の" + name + "を選択しました。盤上のマスをタップしてください。";
        render();
      });
      pickerElement.append(button);
    }
    const remaining = piecesInHand(currentSide(), selectedName).length;
    countElement.textContent = selectedName + "の残数：" + remaining + "枚";
  }
  function renderSummary() {
    summaryElement.replaceChildren();
    for (const side of ["先手", "後手"]) {
      const block = document.createElement("div");
      block.className = "inventory-side";
      const heading = document.createElement("strong");
      heading.textContent = side;
      block.append(heading);
      const line = document.createElement("p");
      line.textContent = Object.keys(E.PIECE_COUNTS).map(name =>
        name + " " + piecesInHand(side, name).length + "/" + E.PIECE_COUNTS[name]
      ).join("　");
      block.append(line);
      summaryElement.append(block);
    }
  }
  function formatSquare(row, col, layer) {
    const base = (col + 1) + "-" + (row + 1);
    return layer == null ? base : base + "-" + layer;
  }
  function renderHistory() {
    const list = document.getElementById("move-history");
    const count = document.getElementById("history-count");
    if (!list || !count) return;
    list.replaceChildren();
    count.textContent = state.history.length + "件";
    if (!state.history.length) {
      const empty = document.createElement("li");
      empty.className = "history-empty";
      empty.textContent = "まだ棋譜はありません。初期配置を始めると、ここに記録されます。";
      list.append(empty);
      return;
    }
    let ply = 0;
    state.history.forEach((entry, index) => {
      const item = document.createElement("li");
      item.className = "history-entry history-" + entry.type;
      const head = document.createElement("strong");
      const detail = document.createElement("span");
      const side = entry.side || (entry.piece && entry.piece.side) || "";
      const pieceName = entry.piece ? entry.piece.name : "駒";
      if (entry.type === "place") {
        head.textContent = "初期配置 · " + side;
        detail.textContent = pieceName + "を " + formatSquare(entry.row, entry.col, entry.layer) + " に配置";
      } else if (entry.type === "deploy") {
        ply += 1;
        head.textContent = "第" + ply + "手 · " + side;
        detail.textContent = pieceName + "を " + formatSquare(entry.row, entry.col, entry.layer) + " に新配置";
      } else if (entry.type === "move") {
        ply += 1;
        head.textContent = "第" + ply + "手 · " + side;
        const from = formatSquare(entry.from.row, entry.from.col, entry.fromLayer ?? entry.from.layer);
        const to = formatSquare(entry.to.row, entry.to.col, entry.toLayer ?? entry.to.layer);
        let description = pieceName + " " + from + " → " + to;
        if (entry.landingMode === "tsuke") {
          description += "（ツケ）";
        } else if (entry.captured && entry.captured.length) {
          description += "（捕獲：" + entry.captured.map(piece => piece.name).join("・") + "／" + entry.captured.length + "枚）";
        }
        detail.textContent = description;
      } else {
        head.textContent = side || "記録";
        detail.textContent = pieceName;
      }
      item.append(head, detail);
      list.append(item);
    });
    list.scrollTop = list.scrollHeight;
  }
  function render() {
    if (mode === "move" && actionMode === "deploy") {
      const piece = piecesInHand(state.turn, selectedName)[0];
      moveTargets = piece ? Array.from({ length: E.SIZE * E.SIZE }, (_, i) => ({
        row: Math.floor(i / E.SIZE), col: i % E.SIZE
      })).filter(p => E.canDeployPiece(state, p.row, p.col, state.turn, piece)) : [];
    }
    boardElement.replaceChildren();
    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.disabled = state.phase === "finished";
        const isTarget = moveTargets.some(p => p.row === row && p.col === col);
        button.className = "square " + ((row + col) % 2 === 0 ? "parity-light" : "parity-brown") + (selected && selected.row === row && selected.col === col ? " selected" : "") + (isTarget ? " legal-target" : "");
        button.setAttribute("aria-label", (col + 1) + "-" + (row + 1) + " マス");
        const coord = document.createElement("span");
        coord.className = "coord";
        coord.textContent = (col + 1) + "," + (row + 1);
        button.append(coord);
        const stack = state.board[row][col];
        if (stack.length) {
          const label = document.createElement("span");
          label.className = "stack-label";
          stack.forEach((piece, layer) => {
            const pieceLabel = document.createElement("span");
            pieceLabel.className = "stack-piece " + (piece.side === "先手" ? "piece-white" : "piece-black");
            pieceLabel.textContent = layer === stack.length - 1 ? piece.name : "";
            pieceLabel.setAttribute("aria-label", (layer + 1) + "段目・" + piece.side + "・" + piece.name);
            // The first layer stays at the square center; higher layers
            // are progressively shifted upward.
            pieceLabel.style.setProperty("top", "calc(50% - " + (layer * 12) + "%)", "important");
            if (piece.side === "後手") {
              pieceLabel.style.setProperty("transform", "translate(-50%, -50%) rotate(180deg)", "important");
            }
            pieceLabel.style.zIndex = String(layer + 1);
            label.append(pieceLabel);
          });
          button.append(label);
          button.classList.add(stack[stack.length - 1].side === "先手" ? "first-side" : "second-side");
        }
        button.addEventListener("click", () => mode === "setup" ? onSquare(row, col) : onMoveSquare(row, col));
        boardElement.append(button);
      }
    }
    selectedElement.textContent = selected ? (selected.col + 1) + "-" + (selected.row + 1) : "なし";
    refreshPiecePicker();
    renderSummary();
    renderHistory();
    document.getElementById("mode-toggle").textContent = state.setupTurn + "の「済」";
    document.getElementById("mode-toggle").disabled = mode !== "setup" || !!state.setupFinishPending;
    document.getElementById("mode-toggle").disabled = mode !== "setup";
    document.getElementById("mode-toggle").hidden = mode !== "setup";
    document.getElementById("status").textContent = state.phase === "finished" ? "対局終了・" + state.winner + "の勝利" : (mode === "setup" ? state.setupTurn + "の配置番" : state.turn + "の手番" + (E.isInCheck(state, state.turn) ? " ・帥手" : ""));
    sideSelect.value = state.setupTurn;
    sideSelect.disabled = true;
    pickerElement.hidden = state.phase === "finished" || (mode === "setup" ? false : actionMode !== "deploy");
    document.querySelector(".setup-controls label").hidden = mode !== "setup";
    sideSelect.hidden = mode !== "setup";
    document.getElementById("deploy-toggle").hidden = mode !== "move" || state.phase === "finished";
    aiButton.hidden = mode !== "move" || state.phase === "finished";
    aiButton.disabled = aiThinking;
    aiButton.textContent = aiThinking ? "思考中…" : "AIで次の手";
    document.getElementById("deploy-toggle").textContent = actionMode === "deploy" ? "移動に戻る" : "新";
  }
  function onSquare(row, col) {
    selected = { row, col };
    const side = currentSide();
    const piece = piecesInHand(side, selectedName)[0];
    if (!piece) {
      messageElement.textContent = side + "の" + selectedName + "は残っていません。";
      infoElement.textContent = "配置は行われていません。";
    } else {
      const result = E.placePiece(state, row, col, side, piece.id);
      messageElement.textContent = result.ok
        ? side + "の" + selectedName + "を " + (col + 1) + "-" + (row + 1) + " に配置しました。" +
          (result.complete ? " 初期配置が完了し、移動モードに移ります。先手から開始します。" :
            (state.setupDone["先手"] && side === "後手" ? " 後手は続けて配置できます。" : " 次は" + result.nextSide + "の番です。"))
        : result.reason;
      if (result.ok && result.complete) {
        mode = "move";
        actionMode = "move";
        infoElement.textContent = "現在の手番：先手";
      }
      infoElement.textContent = result.ok
        ? "このマスの駒は " + state.board[row][col].length + " 枚です。"
        : "配置は行われていません。";
    }
    render();
  }
  function finishMove(row, col, landingMode) {
    const from = pendingMove ? pendingMove.from : selected;
    if (!from) return;
    const result = E.movePiece(state, from.row, from.col, row, col, landingMode);
    if (result.ok) {
      messageElement.textContent = result.piece.name + "を " + (col + 1) + "-" + (row + 1) + " へ移動しました。" +
        (landingMode === "tsuke" ? " 敵駒の上にツケました。" :
          (result.captured.length ? " 敵駒" + result.captured.length + "枚を捕獲。" : ""));
      selected = null;
      moveTargets = [];
      pendingMove = null;
      moveChoiceElement.hidden = true;
      infoElement.textContent = "次の手番：" + state.turn;
      if (result.gameOver) {
        messageElement.textContent = "帥を取りました。対局終了！ " + result.winner + "の勝利です。";
        infoElement.textContent = result.winner + "の勝利。盤面を初期化すると新しい対局を始められます。";
      } else if (E.isInCheck(state, state.turn)) {
        messageElement.textContent += " 帥手です。";
        showCheck(state.turn);
      }
    } else {
      messageElement.textContent = result.reason;
    }
    render();
  }
  function onMoveSquare(row, col) {
    if (state.phase === "finished") return;
    if (actionMode === "deploy") {
      const piece = piecesInHand(state.turn, selectedName)[0];
      if (!piece || !E.canDeployPiece(state, row, col, state.turn, piece)) {
        messageElement.textContent = piece ? "このマスには駒を配置できません。" : "選択した駒は持ち駒にありません。";
        return;
      }
      const result = E.deployPiece(state, row, col, state.turn, piece.id);
      if (result.ok) {
        messageElement.textContent = result.piece.name + "を " + (col + 1) + "-" + (row + 1) + " に配置しました。";
        selected = null;
        moveTargets = [];
        actionMode = "move";
        infoElement.textContent = "次の手番：" + state.turn;
        if (E.isInCheck(state, state.turn)) {
          messageElement.textContent += " 帥手です。";
          showCheck(state.turn);
        }
      } else {
        messageElement.textContent = result.reason;
      }
      render();
      return;
    }
    if (selected && moveTargets.some(p => p.row === row && p.col === col)) {
      const target = E.getStack(state, row, col);
      const targetTop = target && target.length ? target[target.length - 1] : null;
      const movingStack = E.getStack(state, selected.row, selected.col);
      const movingTop = movingStack[movingStack.length - 1];
      if (targetTop) {
        const enemyTop = targetTop.side !== state.turn;
        pendingMove = { from: { ...selected }, to: { row, col } };
        moveChoiceElement.hidden = false;
        captureButton.hidden = !enemyTop;
        tsukeButton.hidden = target.length >= 3;
        messageElement.textContent = enemyTop ? "敵駒のあるマスです。敵駒を取るか、その上にツケるか選択してください。" : "味方の駒があるマスです。その上にツケることができます。";
        infoElement.textContent = "移動方法を選択してください。";
        return;
      }
      finishMove(row, col, "capture");
      return;
    }
    const stack = E.getStack(state, row, col);
    const top = stack && stack.length ? stack[stack.length - 1] : null;
    if (!top || top.side !== currentSide()) {
      messageElement.textContent = currentSide() + "の最上段の駒を選択してください。";
      selected = null;
      moveTargets = [];
    } else {
      selected = { row, col };
      moveTargets = E.getMovementTargets(state, row, col).filter(p => E.canMoveTo(state, row, col, p.row, p.col));
      messageElement.textContent = top.name + "（" + stack.length + "段目）の移動先を表示しています。";
      infoElement.textContent = "移動可能なマス：" + moveTargets.length + "か所";
    }
    render();
  }
  captureButton.addEventListener("click", () => {
    if (pendingMove) finishMove(pendingMove.to.row, pendingMove.to.col, "capture");
  });
  tsukeButton.addEventListener("click", () => {
    if (pendingMove) finishMove(pendingMove.to.row, pendingMove.to.col, "tsuke");
  });
  aiButton.addEventListener("click", async () => {
    if (aiThinking || state.phase !== "move") return;
    if (!window.GungiSearch) {
      messageElement.textContent = "探索エンジンを読み込めませんでした。ページを再読み込みしてください。";
      return;
    }
    aiThinking = true;
    actionMode = "move";
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    messageElement.textContent = state.turn + "のAIが次の手を考えています。";
    infoElement.textContent = "反復深化・αβ枝刈りで探索中です。";
    render();
    try {
      const result = await window.GungiSearch.findBestMove(state, {
        maxDepth: 4,
        timeMs: 1800,
        maxNodes: 60000,
        maxDeployCandidates: 10,
        onProgress: progress => {
          messageElement.textContent = "AI思考中… 深さ " + progress.depth + " ／ " + progress.nodes.toLocaleString() + "局面を探索";
        }
      });
      const action = result.bestMove;
      if (!action) {
        messageElement.textContent = "合法手が見つかりませんでした。";
        infoElement.textContent = "探索深度：" + result.depth;
        return;
      }
      let applied;
      if (action.type === "deploy") {
        applied = E.deployPiece(state, action.row, action.col, state.turn, action.pieceId);
        if (applied.ok) {
          messageElement.textContent = "AIは「新」を選択し、" + applied.piece.name + "を " + (action.col + 1) + "-" + (action.row + 1) + " に配置しました。";
        }
      } else {
        applied = E.movePiece(state, action.from.row, action.from.col, action.to.row, action.to.col, action.landingMode);
        if (applied.ok) {
          messageElement.textContent = "AIは" + applied.piece.name + "を " +
            (action.from.col + 1) + "-" + (action.from.row + 1) + " から " +
            (action.to.col + 1) + "-" + (action.to.row + 1) + " へ" +
            (action.landingMode === "tsuke" ? "ツケました。" :
              (applied.captured.length ? "移動し、敵駒" + applied.captured.length + "枚を捕獲しました。" : "移動しました。"));
        }
      }
      if (!applied || !applied.ok) {
        messageElement.textContent = "探索した手を実行できませんでした。" + (applied && applied.reason ? " " + applied.reason : "");
      } else if (applied.gameOver) {
        messageElement.textContent = "AIが帥を取りました。対局終了！ " + applied.winner + "の勝利です。";
        infoElement.textContent = applied.winner + "の勝利です。";
      } else {
        infoElement.textContent = "探索深度 " + result.depth + " ／ " + result.nodes.toLocaleString() +
          "局面 ／ " + result.elapsedMs + " ms ／ 評価値 " + result.score;
        if (E.isInCheck(state, state.turn)) {
          messageElement.textContent += " 帥手です。";
          showCheck(state.turn);
        }
      }
    } catch (error) {
      messageElement.textContent = "AIの探索中にエラーが発生しました：" + (error && error.message ? error.message : String(error));
      infoElement.textContent = "盤面は変更されていません。";
    } finally {
      aiThinking = false;
      render();
    }
  });
  document.getElementById("deploy-toggle").addEventListener("click", () => {
    actionMode = actionMode === "move" ? "deploy" : "move";
    selected = null;
    pendingMove = null;
    moveChoiceElement.hidden = true;
    moveTargets = [];
    messageElement.textContent = actionMode === "deploy"
      ? "配置する駒を選び、緑色のマスをタップしてください。"
      : "移動モードに戻りました。";
    infoElement.textContent = actionMode === "deploy" ? "配置可能なマスを表示しています。" : "盤上の駒を選択してください。";
    render();
  });
  document.getElementById("mode-toggle").addEventListener("click", () => {
    if (mode !== "setup") return;
    const side = state.setupTurn;
    const result = E.finishSetup(state, side);
    if (!result.ok) {
      messageElement.textContent = result.reason;
      return;
    }
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    messageElement.textContent = side + "が「済」を押しました。このターンで駒を1つ配置すると、" +
      (side === "先手" ? "後手番になります。" : "初期配置が完了し、移動モードに移ります。");
    infoElement.textContent = "配置する駒を1つ選んで盤面に置いてください。";
    render();
  });
  sideSelect.addEventListener("change", () => {
    const names = Object.keys(E.PIECE_COUNTS);
    if (!piecesInHand(currentSide(), selectedName).length) {
      selectedName = names.find(name => piecesInHand(currentSide(), name).length) || names[0];
    }
    messageElement.textContent = currentSide() + "の駒を配置します。";
    render();
  });
  document.getElementById("clear-selection").addEventListener("click", () => {
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    infoElement.textContent = "盤面のマスをタップしてください。";
    render();
  });
  document.getElementById("reset-board").addEventListener("click", () => {
    const fresh = E.createGameState();
    state.board = fresh.board;
    state.hands = fresh.hands;
    state.history = [];
    state.turn = fresh.turn;
    state.setupTurn = fresh.setupTurn;
    state.setupDone = fresh.setupDone;
    state.setupFinishPending = fresh.setupFinishPending;
    state.phase = fresh.phase;
    state.winner = fresh.winner;
    mode = "setup";
    actionMode = "move";
    state.moveNumber = fresh.moveNumber;
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    selectedName = "帥";
    messageElement.textContent = "盤面と持ち駒を初期状態に戻しました。";
    infoElement.textContent = "盤面を初期化しました。";
    render();
  });
  render();
})();