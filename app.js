(() => {
  "use strict";
  const E = window.GungiEngine;
  const state = E.createGameState();
  const boardElement = document.getElementById("board");
  const sideSelect = document.getElementById("side-select");
  const pieceSelect = document.getElementById("piece-select");
  const operationSelect = document.getElementById("operation-select");
  const countElement = document.getElementById("inventory-count");
  const summaryElement = document.getElementById("inventory-summary");
  const messageElement = document.getElementById("message");
  const selectedElement = document.getElementById("selected");
  const infoElement = document.getElementById("cell-info");
  let selected = null;

  function currentSide() { return sideSelect.value; }
  function selectedPiece() { return pieceSelect.value; }
  function refreshPieceOptions() {
    const hand = state.hands[currentSide()];
    const previous = selectedPiece();
    pieceSelect.replaceChildren();
    const names = Object.keys(E.PIECE_COUNTS);
    for (const name of names) {
      const count = hand.filter(piece => piece.name === name).length;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name + "（残り " + count + "）";
      option.disabled = count === 0;
      pieceSelect.append(option);
    }
    if (names.includes(previous) && hand.some(piece => piece.name === previous)) {
      pieceSelect.value = previous;
    } else {
      const firstAvailable = names.find(name => hand.some(piece => piece.name === name));
      if (firstAvailable) pieceSelect.value = firstAvailable;
    }
    const available = hand.filter(piece => piece.name === selectedPiece());
    countElement.textContent = "選択中の駒の残数：" + available.length + " 枚";
    if (!available.length) countElement.textContent = "この陣営の持ち駒はありません。";
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
        name + " " + state.hands[side].filter(piece => piece.name === name).length + "/" + E.PIECE_COUNTS[name]
      ).join("　");
      block.append(line);
      summaryElement.append(block);
    }
  }
  function render() {
    boardElement.replaceChildren();
    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const button = document.createElement("button");
        button.type = "button";
        const isSelected = selected && selected.row === row && selected.col === col;
        button.className = "square" + (isSelected ? " selected" : "");
        button.setAttribute("aria-label", (col + 1) + "-" + (row + 1) + " マス");
        const coord = document.createElement("span");
        coord.className = "coord";
        coord.textContent = (col + 1) + "," + (row + 1);
        button.append(coord);
        const stack = state.board[row][col];
        if (stack.length) {
          const names = stack.map(piece => piece.name);
          const text = document.createElement("span");
          text.className = "stack-label";
          text.textContent = names.join("・");
          button.append(text);
          button.classList.add(stack[stack.length - 1].side === "先手" ? "first-side" : "second-side");
        }
        button.addEventListener("click", () => onSquare(row, col));
        boardElement.append(button);
      }
    }
    if (selected) selectedElement.textContent = (selected.col + 1) + "-" + (selected.row + 1);
    else selectedElement.textContent = "なし";
    refreshPieceOptions();
    renderSummary();
  }
  function onSquare(row, col) {
    const stack = state.board[row][col];
    selected = { row, col };
    if (operationSelect.value === "remove") {
      const result = E.removeTopPiece(state, row, col);
      if (result.ok) {
        messageElement.textContent = result.piece.side + "の" + result.piece.name + "を手持ちに戻しました。";
        infoElement.textContent = "このマスの駒を1枚取り除きました。残り " + state.board[row][col].length + " 枚。";
      } else messageElement.textContent = result.reason;
    } else {
      const side = currentSide();
      const name = selectedPiece();
      const piece = state.hands[side].find(item => item.name === name);
      if (!piece) messageElement.textContent = "配置できる駒がありません。";
      else {
        const result = E.placePiece(state, row, col, side, piece.id);
        messageElement.textContent = result.ok
          ? side + "の" + name + "を " + (col + 1) + "-" + (row + 1) + " に配置しました。"
          : result.reason;
        infoElement.textContent = result.ok ? "このマスの駒は " + state.board[row][col].length + " 枚です。" : "配置は行われていません。";
      }
    }
    render();
  }
  sideSelect.addEventListener("change", () => { messageElement.textContent = currentSide() + "の駒を配置します。"; render(); });
  pieceSelect.addEventListener("change", refreshPieceOptions);
  document.getElementById("clear-selection").addEventListener("click", () => {
    selected = null; infoElement.textContent = "盤面のマスをタップしてください。"; render();
  });
  document.getElementById("reset-board").addEventListener("click", () => {
    const fresh = E.createGameState();
    state.board = fresh.board; state.hands = fresh.hands; state.history = [];
    selected = null; messageElement.textContent = "盤面と持ち駒を初期状態に戻しました。";
    infoElement.textContent = "盤面を初期化しました。"; render();
  });
  render();
})();