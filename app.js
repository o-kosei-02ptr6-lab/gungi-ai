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
  let selectedName = "兵";
  function currentSide() { return sideSelect.value; }
  function piecesInHand(side, name) {
    return state.hands[side].filter(piece => piece.name === name);
  }
  function refreshPiecePicker() {
    const hand = state.hands[currentSide()];
    const names = Object.keys(E.PIECE_COUNTS);
    if (!hand.some(piece => piece.name === selectedName)) {
      selectedName = names.find(name => hand.some(piece => piece.name === name)) || names[0];
    }
    pickerElement.replaceChildren();
    for (const name of names) {
      const count = piecesInHand(currentSide(), name).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "piece-choice" + (name === selectedName ? " active" : "");
      button.disabled = count === 0;
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
  function render() {
    boardElement.replaceChildren();
    for (let row = 0; row < E.SIZE; row += 1) {
      for (let col = 0; col < E.SIZE; col += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "square" + (selected && selected.row === row && selected.col === col ? " selected" : "");
        button.setAttribute("aria-label", (col + 1) + "-" + (row + 1) + " マス");
        const coord = document.createElement("span");
        coord.className = "coord";
        coord.textContent = (col + 1) + "," + (row + 1);
        button.append(coord);
        const stack = state.board[row][col];
        if (stack.length) {
          const label = document.createElement("span");
          label.className = "stack-label";
          label.textContent = stack.map(piece => piece.name).join("・");
          button.append(label);
          button.classList.add(stack[stack.length - 1].side === "先手" ? "first-side" : "second-side");
        }
        button.addEventListener("click", () => onSquare(row, col));
        boardElement.append(button);
      }
    }
    selectedElement.textContent = selected ? (selected.col + 1) + "-" + (selected.row + 1) : "なし";
    refreshPiecePicker();
    renderSummary();
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
        ? side + "の" + selectedName + "を " + (col + 1) + "-" + (row + 1) + " に配置しました。"
        : result.reason;
      infoElement.textContent = result.ok
        ? "このマスの駒は " + state.board[row][col].length + " 枚です。"
        : "配置は行われていません。";
    }
    render();
  }
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
    infoElement.textContent = "盤面のマスをタップしてください。";
    render();
  });
  document.getElementById("reset-board").addEventListener("click", () => {
    const fresh = E.createGameState();
    state.board = fresh.board;
    state.hands = fresh.hands;
    state.history = [];
    selected = null;
    selectedName = "兵";
    messageElement.textContent = "盤面と持ち駒を初期状態に戻しました。";
    infoElement.textContent = "盤面を初期化しました。";
    render();
  });
  render();
})();