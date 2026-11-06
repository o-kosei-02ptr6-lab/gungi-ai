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
  let mode = "setup";
  let moveTargets = [];
  let pendingMove = null;
  let actionMode = "move";
  const moveChoiceElement = document.getElementById("move-choice");
  const captureButton = document.getElementById("capture-choice");
  const tsukeButton = document.getElementById("tsuke-choice");
  function currentSide() { return mode === "move" ? state.turn : state.setupTurn; }
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
        const isTarget = moveTargets.some(p => p.row === row && p.col === col);
        button.className = "square" + (selected && selected.row === row && selected.col === col ? " selected" : "") + (isTarget ? " legal-target" : "");
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
            pieceLabel.textContent = piece.name;
            pieceLabel.setAttribute("aria-label", (layer + 1) + "段目・" + piece.side + "・" + piece.name);
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
    document.getElementById("mode-toggle").textContent = mode === "setup" ? "移動モードに切り替え" : "配置モードに戻る";
    document.getElementById("status").textContent = mode === "setup" ? state.setupTurn + "の配置番" : state.turn + "の手番";
    sideSelect.value = state.setupTurn;
    sideSelect.disabled = true;
    pickerElement.hidden = mode === "setup" ? false : actionMode !== "deploy";
    document.querySelector(".setup-controls label").hidden = mode !== "setup";
    sideSelect.hidden = mode !== "setup";
    document.getElementById("deploy-toggle").hidden = mode !== "move";
    document.getElementById("deploy-toggle").textContent = actionMode === "deploy" ? "移動に戻る" : "駒を配置する";
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
        ? side + "の" + selectedName + "を " + (col + 1) + "-" + (row + 1) + " に配置しました。次は" + result.nextSide + "の番です。"
        : result.reason;
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
    } else {
      messageElement.textContent = result.reason;
    }
    render();
  }
  function onMoveSquare(row, col) {
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
      } else {
        messageElement.textContent = result.reason;
      }
      render();
      return;
    }
    if (selected && moveTargets.some(p => p.row === row && p.col === col)) {
      const target = E.getStack(state, row, col);
      const targetTop = target && target.length ? target[target.length - 1] : null;
      const targetHasFriendly = target && target.some(piece => piece.side === state.turn);
      if (targetTop && targetTop.side !== state.turn && !targetHasFriendly) {
        pendingMove = { from: { ...selected }, to: { row, col } };
        moveChoiceElement.hidden = false;
        tsukeButton.hidden = target.length >= 3;
        messageElement.textContent = "敵駒のあるマスです。敵駒を取るか、その上にツケるか選択してください。";
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
    mode = mode === "setup" ? "move" : "setup";
    actionMode = "move";
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    messageElement.textContent = mode === "setup" ? "配置モードに戻りました。" : "移動モードです。先手から開始します。";
    infoElement.textContent = mode === "move" ? "現在の手番：" + state.turn : "盤面のマスをタップしてください。";
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
    state.moveNumber = fresh.moveNumber;
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    selectedName = "兵";
    messageElement.textContent = "盤面と持ち駒を初期状態に戻しました。";
    infoElement.textContent = "盤面を初期化しました。";
    render();
  });
  render();
})();