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
  let trainingRunning = false;
  let trainingStopRequested = false;
  let tournamentRunning = false;
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
    const base = (E.SIZE - col) + "-" + (row + 1);
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
  let savedReplayFrames=[];
  let savedReplayIndex=0;
  function cloneReplaySnapshot(source){
    return {board:source.board.map(row=>row.map(stack=>stack.slice())),hands:{"先手":source.hands["先手"].slice(),"後手":source.hands["後手"].slice()},turn:source.turn,phase:source.phase,winner:source.winner||null,moveNumber:source.moveNumber||1};
  }
  function replayLabel(entry,index){
    const side=entry.side||(entry.piece&&entry.piece.side)||"";
    const name=entry.piece?entry.piece.name:"駒";
    if(entry.type==="place")return "初期配置 · "+side+"："+name+"を "+formatSquare(entry.row,entry.col,entry.layer)+" に配置";
    if(entry.type==="deploy")return "第"+index+"手 · "+side+"："+name+"を "+formatSquare(entry.row,entry.col,entry.layer)+" に新配置";
    if(entry.type==="move"){
      const from=formatSquare(entry.from.row,entry.from.col,entry.fromLayer??entry.from.layer);
      const to=formatSquare(entry.to.row,entry.to.col,entry.toLayer??entry.to.layer);
      let label="第"+index+"手 · "+side+"："+name+" "+from+" → "+to;
      if(entry.landingMode==="tsuke")label+="（ツケ）";
      else if(entry.captured&&entry.captured.length)label+="（捕獲："+entry.captured.map(piece=>piece.name).join("・")+"／"+entry.captured.length+"枚）";
      return label;
    }
    return side+"："+name;
  }
  function buildSavedReplay(history,finalState){
    if(!Array.isArray(history)||!history.length)return finalState?[{snapshot:cloneReplaySnapshot(finalState),label:"棋譜未保存・最終局面"}]:[];
    const state=E.createGameState(),frames=[{snapshot:cloneReplaySnapshot(state),label:"初期局面"}];
    let ply=0;
    (Array.isArray(history)?history:[]).forEach(entry=>{
      const side=entry.side||(entry.piece&&entry.piece.side);
      if(entry.type==="place"||entry.type==="deploy"){
        const hand=state.hands[side]||[];
        const handIndex=hand.findIndex(piece=>entry.piece&&piece.id===entry.piece.id);
        const piece=handIndex>=0?hand.splice(handIndex,1)[0]:entry.piece;
        if(!piece)return;
        state.board[entry.row][entry.col].push(piece);
        if(entry.type==="deploy"){ply++;state.phase="move";state.turn=side==="先手"?"後手":"先手";}
      }else if(entry.type==="move"&&entry.from&&entry.to){
        ply++;
        const source=state.board[entry.from.row][entry.from.col],destination=state.board[entry.to.row][entry.to.col];
        const moving=source.pop()||entry.piece;
        if(entry.landingMode!=="tsuke"&&Array.isArray(entry.captured)&&entry.captured.length){
          const capturedIds=new Set(entry.captured.map(piece=>piece.id));
          for(let i=destination.length-1;i>=0;i--)if(capturedIds.has(destination[i].id))destination.splice(i,1);
        }
        destination.push(moving);
        state.phase="move";
        state.turn=side==="先手"?"後手":"先手";
        if((entry.captured||[]).some(piece=>piece.name==="帥")){state.phase="finished";state.winner=side;}
      }
      frames.push({snapshot:cloneReplaySnapshot(state),label:replayLabel(entry,ply)});
    });
    return frames;
  }
  function renderSavedGameHistory(history){
    const list=document.getElementById("tournament-game-history"),count=document.getElementById("tournament-game-history-count");
    if(!list||!count)return;
    list.replaceChildren();
    if(!Array.isArray(history)||!history.length){
      count.textContent="棋譜なし";
      const empty=document.createElement("li");empty.className="history-empty";
      empty.textContent="この対局には保存済みの棋譜がありません。新しい対局を実行すると、勝敗に関係なく最新1局の棋譜を保存します。";
      list.append(empty);return;
    }
    count.textContent=history.length+"件";
    let ply=0;
    history.forEach((entry,index)=>{
      if(entry.type==="deploy"||entry.type==="move")ply++;
      const item=document.createElement("li");item.className="history-entry history-"+entry.type;
      const head=document.createElement("strong"),detail=document.createElement("span"),label=replayLabel(entry,ply);
      head.textContent=label.split("：")[0];
      detail.textContent=label.includes("：")?label.slice(label.indexOf("：")+1):label;
      item.append(head,detail);
      item.addEventListener("click",()=>{savedReplayIndex=index+1;renderSavedReplayFrame();});
      item.style.cursor="pointer";list.append(item);
    });
  }
  function renderTournamentBoard(snapshot) {
    const board=document.getElementById("tournament-board");if(!board)return;board.replaceChildren();
    for(let row=0;row<E.SIZE;row++)for(let col=0;col<E.SIZE;col++){
      const cell=document.createElement("div");cell.className="square "+((row+col)%2===0?"parity-light":"parity-brown");
      const coord=document.createElement("span");coord.className="coord";coord.textContent=(E.SIZE-col)+","+(row+1);cell.append(coord);
      const stack=snapshot.board[row][col]||[];
      if(stack.length){const label=document.createElement("span");label.className="stack-label";
        stack.forEach((piece,layer)=>{const face=document.createElement("span");face.className="stack-piece "+(piece.side==="先手"?"piece-white":"piece-black");face.textContent=layer===stack.length-1?piece.name:"";face.setAttribute("aria-label",(layer+1)+"段目・"+piece.side+"・"+piece.name);face.style.setProperty("top","calc(50% - "+(layer*12)+"%)","important");if(piece.side==="後手")face.style.setProperty("transform","translate(-50%, -50%) rotate(180deg)","important");face.style.zIndex=String(layer+1);label.append(face);});
        cell.append(label);cell.classList.add(stack[stack.length-1].side==="先手"?"first-side":"second-side");}
      board.append(cell);
    }
  }
  function renderSavedReplayFrame(){
    if(!savedReplayFrames.length)return;
    savedReplayIndex=Math.max(0,Math.min(savedReplayFrames.length-1,savedReplayIndex));
    const frame=savedReplayFrames[savedReplayIndex];
    renderTournamentBoard(frame.snapshot);
    const status=document.getElementById("tournament-replay-status"),range=document.getElementById("tournament-replay-range");
    const previous=document.getElementById("tournament-replay-prev"),next=document.getElementById("tournament-replay-next");
    const first=document.getElementById("tournament-replay-first"),last=document.getElementById("tournament-replay-last");
    if(status)status.textContent="局面 "+savedReplayIndex+" / "+(savedReplayFrames.length-1)+"　"+frame.label+"　"+(frame.snapshot.phase==="finished"?"対局終了":frame.snapshot.phase==="setup"?"配置中":frame.snapshot.turn+"の手番");
    if(range){range.max=String(savedReplayFrames.length-1);range.value=String(savedReplayIndex);range.disabled=savedReplayFrames.length<=1;}
    if(previous)previous.disabled=savedReplayIndex===0;if(first)first.disabled=savedReplayIndex===0;
    if(next)next.disabled=savedReplayIndex>=savedReplayFrames.length-1;if(last)last.disabled=savedReplayIndex>=savedReplayFrames.length-1;
  }
  function refreshTournamentGames(selectedId){
    const select=document.getElementById("tournament-game-select"),detail=document.getElementById("tournament-game-detail"),viewer=document.getElementById("tournament-board-view");
    if(!select||!window.GungiTournament)return;
    const records=window.GungiTournament.listGameRecords().slice().sort((a,b)=>String(b.savedAt||"").localeCompare(String(a.savedAt||""))),previous=selectedId||select.value;
    select.replaceChildren();
    const gameLabel=record=>record.source==="自己学習"?"自己学習・第"+record.game+"局":"第"+record.pair+"組・第"+record.game+"局";
    if(!records.length){
      const option=document.createElement("option");option.value="";option.textContent="保存された対局はありません";select.append(option);select.disabled=true;
      if(detail)detail.textContent="対局が保存されると、ここに結果が表示されます。";
      if(viewer)viewer.hidden=true;
      renderSavedGameHistory([]);savedReplayFrames=[];savedReplayIndex=0;return;
    }
    select.disabled=false;
    records.forEach(record=>{const option=document.createElement("option");option.value=record.id;option.textContent=gameLabel(record)+"／学習AI "+record.candidateSide+"／"+(record.draw?"引き分け":record.winner+"勝")+"／"+record.plies+"手";select.append(option);});
    const chosen=records.find(record=>record.id===previous)||records[0];select.value=chosen.id;
    if(detail){const handCount=side=>Object.keys(E.PIECE_COUNTS).map(name=>name+" "+(chosen.finalState.hands[side]||[]).filter(piece=>piece.name===name).length).join("・");detail.textContent=gameLabel(chosen)+"。学習AI："+chosen.candidateSide+"／結果："+(chosen.draw?"引き分け":chosen.winner+"の勝利")+"／"+chosen.plies+"手。最終手番："+chosen.finalState.turn+".\n先手の持ち駒："+handCount("先手")+"\n後手の持ち駒："+handCount("後手");}
    // Replay is intentionally independent of the record selector: it always shows
    // the newest saved game, while the selector above only inspects final positions.
    const latest=records[0];
    savedReplayFrames=Array.isArray(latest.history)&&latest.history.length?buildSavedReplay(latest.history):[];
    savedReplayIndex=0;
    renderSavedGameHistory(latest.history);
    if(viewer)viewer.hidden=!savedReplayFrames.length;
    if(savedReplayFrames.length)renderSavedReplayFrame();
    else{
      const status=document.getElementById("tournament-replay-status");
      if(status)status.textContent="最新の対局に棋譜がありません。次の対局から初期配置を含む棋譜を保存します。";
    }
  }
  const tournamentSelect=document.getElementById("tournament-game-select");
  if(tournamentSelect)tournamentSelect.addEventListener("change",()=>refreshTournamentGames(tournamentSelect.value));
  const replayBindings=[
    ["tournament-replay-prev",()=>savedReplayIndex--],
    ["tournament-replay-next",()=>savedReplayIndex++],
    ["tournament-replay-first",()=>savedReplayIndex=0],
    ["tournament-replay-last",()=>savedReplayIndex=savedReplayFrames.length-1]
  ];
  replayBindings.forEach(([id,action])=>{const button=document.getElementById(id);if(button)button.addEventListener("click",()=>{action();renderSavedReplayFrame();});});
  const replayRange=document.getElementById("tournament-replay-range");
  if(replayRange)replayRange.addEventListener("input",()=>{savedReplayIndex=Number(replayRange.value);renderSavedReplayFrame();});
  refreshTournamentGames();
  function render() {
    if (mode === "setup") {
      const piece = piecesInHand(state.setupTurn, selectedName)[0];
      moveTargets = piece ? Array.from({ length: E.SIZE * E.SIZE }, (_, i) => ({
        row: Math.floor(i / E.SIZE), col: i % E.SIZE
      })).filter(p => E.canPlacePiece(state, p.row, p.col, piece)) : [];
    } else if (mode === "move" && actionMode === "deploy") {
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
        button.setAttribute("aria-label", (E.SIZE - col) + "-" + (row + 1) + " マス");
        const coord = document.createElement("span");
        coord.className = "coord";
        coord.textContent = (E.SIZE - col) + "," + (row + 1);
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
    selectedElement.textContent = selected ? (E.SIZE - selected.col) + "-" + (selected.row + 1) : "なし";
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
    aiButton.hidden = state.phase === "finished";
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
        ? side + "の" + selectedName + "を " + (E.SIZE - col) + "-" + (row + 1) + " に" +
          (state.board[row][col].length > 1 ? state.board[row][col].length + "段目として重ねて" : "") + "配置しました。" +
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
      messageElement.textContent = result.piece.name + "を " + (E.SIZE - col) + "-" + (row + 1) + " へ移動しました。" +
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
        messageElement.textContent = result.piece.name + "を " + (E.SIZE - col) + "-" + (row + 1) + " に配置しました。";
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
    if (aiThinking || trainingRunning || tournamentRunning) return;
    if (!window.GungiSearch) {
      messageElement.textContent = "探索エンジンを読み込めませんでした。ページを再読み込みしてください。";
      return;
    }
    if (state.phase === "setup") {
      aiThinking = true;
      selected = null;
      moveTargets = [];
      pendingMove = null;
      messageElement.textContent = state.setupTurn + "のAIが初期配置を考えています。";
      infoElement.textContent = "合法な配置候補を評価しています。";
      render();
      try {
        const result = await window.GungiSearch.findBestSetupPlacement(state, {
          timeMs: 1400,
          maxNodes: 700,
          onProgress: progress => {
            messageElement.textContent = "配置を検討中… " + progress.nodes.toLocaleString() + "候補を評価";
          }
        });
        const action = result.bestMove;
        if (!action) {
          messageElement.textContent = "配置できる駒・マスが見つかりませんでした。「済」または盤面の状態を確認してください。";
          infoElement.textContent = "評価候補：" + result.nodes;
          return;
        }
        const side = state.setupTurn;
        let pressedFinish = false;
        if (result.finishRecommended) {
          const finish = E.finishSetup(state, side);
          if (!finish.ok) throw new Error("AIの「済」を実行できませんでした。" + finish.reason);
          pressedFinish = true;
        }
        const applied = E.placePiece(state, action.row, action.col, side, action.pieceId);
        if (!applied.ok) {
          messageElement.textContent = "AIが選んだ配置を実行できませんでした。" + applied.reason;
        } else {
          if (applied.complete) {
            mode = "move";
            actionMode = "move";
          }
          messageElement.textContent = "AI（" + side + "）は" +
            (pressedFinish ? "「済」を押し、" : "") + applied.piece.name + "を " +
            (E.SIZE - action.col) + "-" + (action.row + 1) + " に配置しました。" +
            (applied.complete ? " 初期配置が完了し、移動モードに移ります。" : " 次は" + state.setupTurn + "の配置です。");
          infoElement.textContent = "配置評価値 " + Math.round(result.score) +
            " ／ 追加配置の評価 " + Math.round(result.gain) +
            (pressedFinish ? " ／ AIが初期配置の終了を判断" : "") +
            " ／ " + result.nodes.toLocaleString() + "候補 ／ " + result.elapsedMs + " ms";
        }
      } catch (error) {
        messageElement.textContent = "AIの配置中にエラーが発生しました：" + (error && error.message ? error.message : String(error));
        infoElement.textContent = "盤面は変更されていません。";
      } finally {
        aiThinking = false;
        render();
      }
      return;
    }
    if (state.phase !== "move") return;
    aiThinking = true;
    actionMode = "move";
    selected = null;
    moveTargets = [];
    pendingMove = null;
    moveChoiceElement.hidden = true;
    messageElement.textContent = state.turn + "のAIが次の手を考えています。";
    infoElement.textContent = "反復深化・αβ枝刈り・手順序改善・PVSで最大5秒間探索します。";
    render();
    try {
      const result = await window.GungiSearch.findBestMove(state, {
        maxDepth: 6,
        timeMs: 5000,
        maxNodes: 180000,
        maxDeployCandidates: 12,
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
          messageElement.textContent = "AIは「新」を選択し、" + applied.piece.name + "を " + (E.SIZE - action.col) + "-" + (action.row + 1) + " に配置しました。";
        }
      } else {
        applied = E.movePiece(state, action.from.row, action.from.col, action.to.row, action.to.col, action.landingMode);
        if (applied.ok) {
          messageElement.textContent = "AIは" + applied.piece.name + "を " +
            (E.SIZE - action.from.col) + "-" + (action.from.row + 1) + " から " +
            (E.SIZE - action.to.col) + "-" + (action.to.row + 1) + " へ" +
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
  const trainButton = document.getElementById("train-ai");
  if (trainButton && window.GungiTraining) {
    trainButton.addEventListener("click", async () => {
      const trainingStatus = document.getElementById("training-status");
      const trainingInfo = document.getElementById("training-info");
      if (trainingRunning) {
        trainingStopRequested = true;
        trainButton.disabled = true;
        trainButton.textContent = "停止中…";
        trainingStatus.textContent = "停止要求を受け付けました。実行中の2局が終了してから停止します。";
        return;
      }
      if (aiThinking || tournamentRunning) return;
      trainingRunning = true;
      trainingStopRequested = false;
      trainButton.disabled = false;
      trainButton.textContent = "学習を停止";
      trainingStatus.textContent = "自己対局学習を開始しました。停止ボタンを押すまで繰り返します。";
      trainingInfo.textContent = "独立したWorkerで2局を同時に進めます。帥手から実際の帥捕獲につながった手順と、探索で証明できた詰み筋を専用特徴に直接学習します。";
      let result = null;
      try {
        result = await window.GungiTraining.train({
          continuous: true,
          maxPlies: 108,
          parallelGames: 2,
          shouldStop: () => trainingStopRequested,
          onProgress: p => {
            trainingStatus.textContent = p.phase === "parallel"
              ? "2局を同時に対局中…（完了 " + p.completedGames + "局）"
              : "第" + p.game + "局の結果を評価関数へ反映・保存中…";
            if (p.phase === "learning") refreshTournamentGames();
            trainingInfo.textContent = "累計探索局面 " + p.nodes.toLocaleString() + " ／ " +
              (p.phase === "learning" ? "TD目標 " + Number(p.target).toFixed(3) + " ／ 学習AI " + p.candidateWins + "勝・最良AI " + p.championWins + "勝・規定手数引き分け " + p.draws + "局" : "学習データ収集中");
          }
        });
        refreshTournamentGames();
        trainingStatus.textContent = trainingStopRequested
          ? "学習を停止しました。学習済みの重みは保存されています。"
          : "学習処理が終了しました。学習済みの重みは保存されています。";
        trainingInfo.textContent = result.games + "局 ／ 決着 " + result.decisive + "局 ／ " +
          "学習AI " + result.candidateWins + "勝 ／ 最良AI " + result.championWins + "勝 ／ 先手 " + result.firstWins + "勝・後手 " + result.secondWins + "勝 ／ 引き分け " + result.draws + "局（固定判定 " + result.adjudicatedGames + "局） ／ 学習局面 " + result.samples +
          " ／ TD更新 " + result.tdUpdates + "回 ／ 詰み筋の直接更新 " + (result.mateUpdates||0) + "回 ／ 平均TD誤差 " + result.meanTdError.toFixed(4) +
          " ／ 同時対局 " + (result.parallelGames||1) + "局 ／ 探索 " + result.nodes.toLocaleString() + "局面";
      } catch (error) {
        trainingStatus.textContent = "学習中にエラーが発生しました。";
        trainingInfo.textContent = error && error.message ? error.message : String(error);
      } finally {
        trainingRunning = false;
        trainingStopRequested = false;
        trainButton.disabled = false;
        trainButton.textContent = "自己対局学習を実行";
      }
    });
  }
  const compareButton = document.getElementById("compare-ai");
  if (compareButton && window.GungiTournament) {
    compareButton.addEventListener("click", async () => {
      if (trainingRunning || aiThinking) return;
      if (tournamentRunning) {
        tournamentRunning = false;
        compareButton.disabled = true;
        compareButton.textContent = "停止処理中…";
        status.textContent = "停止要求を受け付けました。実行中の先後1組が終わった時点で停止します。";
        return;
      }
      tournamentRunning = true;
      compareButton.disabled = true;
      compareButton.textContent = "比較対局中…";
      const status = document.getElementById("compare-status");
      const info = document.getElementById("compare-info");
      compareButton.disabled = false;
      compareButton.textContent = "検証を停止";
      status.textContent = "統計的に有効な結論が出るまで、基準AIとの比較を自動で続けます。";
      info.textContent = "同じ初期配置で先手・後手を入れ替えて比較します。引き分けは共通の評価関数で最終局面の優劣を測ります。このとき帥の安全性・詰み筋の比重を通常の2.5倍にし、その他の項目は通常どおりにします。引き分けは0.3点を基準に、最終局面の優劣に応じて±0.2点補正してペア判定に反映します。最低40局から90%信頼区間を確認し、最大200局まで検証します。";
      try {
        const result = await window.GungiTournament.compare({
          pairs: 2, maxPlies: 108, maxDepth: 2, timeMs: 60, maxNodes: 700, maxDeployCandidates: 2,
          shouldStop: () => !tournamentRunning,
          onProgress: p => {
            if (p.phase === "game") {
              status.textContent = "累計" + (p.totalGames||0) + "局・第" + p.pair + "組の第" + p.game +
                "局を対戦中… " + p.plies + "手 ／ " + p.nodes.toLocaleString() + "局面";
            } else if (p.phase === "pairDone") {
              status.textContent = "累計" + p.totalGames + "局。引き分け最終局面の平均評価 " + (p.averageDrawEval>=0?"+":"") + Math.round(p.averageDrawEval||0) +
                " ／ ペア勝率 " + ((p.pairedRate||0)*100).toFixed(1) + "%・90%信頼区間 " + (p.lowerBound*100).toFixed(1) + "〜" + (p.upperBound*100).toFixed(1) + "%。検証中…";
            } else if (p.phase === "continuing") {
              status.textContent = "累計" + p.totalGames + "局。先後入替ペアで統計的な結論が出るまで検証を続けています…";
            }
          }
        });
        refreshTournamentGames();
        if (result.alreadyChampion) {
          status.textContent = "現在の評価関数は、保存済みの最良AIと同じです。";
          info.textContent = "新しい学習結果ができたら、改めて比較できます。";
        } else {
          const rate = (result.scoreRate * 100).toFixed(1);
          const lower = (result.lowerBound * 100).toFixed(1);
          status.textContent = result.stopped
            ? "検証を停止しました。累計" + result.totalGames + "局のデータを保存しています。"
            : result.inconclusive ? "最大200局を検証しました。現時点では優劣を判定できません。"
            : "検証完了。累計" + result.totalGames + "局。学習AIの得点率：" + rate + "%";
          info.textContent = "今回：" + result.candidateWins + "勝 ／ 最良AI " + result.championWins +
            "勝 ／ 引き分け " + result.draws + "局（" + result.games + "局）。累計：" +
            result.totalCandidateWins + "勝 ／ 最良AI " + result.totalChampionWins +
            "勝 ／ 引き分け " + result.totalDraws + "局。先後入替ペア " + (result.pairWins||0) + "勝・" +
            (result.pairLosses||0) + "敗・" + (result.pairDraws||0) + "分。ペア勝率 " +
            ((result.pairedRate||0)*100).toFixed(1) + "%、90%信頼区間 " + lower + "〜" + (result.upperBound*100).toFixed(1) + "%。引き分け局面の平均評価：" +
            (result.averageDrawEval>=0?"+":"") + Math.round(result.averageDrawEval||0) + "（候補AI視点・" + (result.evaluatedDraws||0) + "局）。 " +
            (result.promoted ? "統計的に改善が確認されたため、新しい評価関数を最良AIとして保存しました。" :
              result.rejected ? "統計的に改善が確認できなかったため、最良AIの評価関数に戻しました。" :
              result.inconclusive ? "最大200局ではペア比較で優劣を断定できませんでした。評価関数は変更せず、結果を保存しました。" :
              "途中停止しました。累積データは保存されているため、次回は続きから検証できます。");
        }
      } catch (error) {
        status.textContent = "比較中にエラーが発生しました。";
        info.textContent = error && error.message ? error.message : String(error);
      } finally {
        tournamentRunning = false;
        compareButton.disabled = false;
        compareButton.textContent = "基準AIと実力を比較";
      }
    });
  }
  const exportTrainingButton = document.getElementById("export-training");
  const copyTrainingButton = document.getElementById("copy-training");
  const importTrainingButton = document.getElementById("import-training");
  const transferTextarea = document.getElementById("training-transfer-data");
  const transferStatus = document.getElementById("transfer-status");
  if (exportTrainingButton && window.GungiTraining) {
    exportTrainingButton.addEventListener("click", () => {
      try {
        transferTextarea.value = JSON.stringify(window.GungiTraining.exportData(), null, 2);
        transferStatus.textContent = "書き出しました。データをコピーして引き継ぎ先へ送ってください。";
      } catch (error) {
        transferStatus.textContent = "書き出しに失敗しました：" + (error.message || String(error));
      }
    });
  }
  if (copyTrainingButton && transferTextarea) {
    copyTrainingButton.addEventListener("click", async () => {
      if (!transferTextarea.value.trim()) {
        transferStatus.textContent = "先に「引き継ぎデータを書き出す」を押してください。";
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(transferTextarea.value);
          transferStatus.textContent = "引き継ぎデータをコピーしました。";
        } else {
          transferTextarea.focus();
          transferTextarea.select();
          transferStatus.textContent = "自動コピーに対応していません。選択された文字列をコピーしてください。";
        }
      } catch (_) {
        transferTextarea.focus();
        transferTextarea.select();
        transferStatus.textContent = "自動コピーできませんでした。選択された文字列をコピーしてください。";
      }
    });
  }
  const restoreBackupButton = document.getElementById("restore-training-backup");
  if (restoreBackupButton && window.GungiTraining) {
    restoreBackupButton.addEventListener("click", () => {
      try {
        const result = window.GungiTraining.restorePreviousBackup();
        transferStatus.textContent = "直前のバックアップを復元しました。学習AI " + result.games +
          "局分 ／ 最良AI " + (result.hasChampion ? "あり" : "初期状態") +
          " ／ 検証記録 " + (result.hasTournament ? "あり" : "なし") + "。復元前の状態も直前バックアップとして保存されています。";
        const trainingStatus = document.getElementById("training-status");
        if (trainingStatus) trainingStatus.textContent = "バックアップから学習データを復元しました。";
      } catch (error) {
        transferStatus.textContent = "バックアップを復元できませんでした：" + (error.message || String(error));
      }
    });
  }
  if (importTrainingButton && window.GungiTraining) {
    importTrainingButton.addEventListener("click", () => {
      try {
        if (!transferTextarea.value.trim()) throw new Error("引き継ぎデータを貼り付けてください。");
        const result = window.GungiTraining.importData(transferTextarea.value.trim());
        transferStatus.textContent = "読み込み完了。学習済み " + result.games + "局分の情報と評価関数の重みをこの端末に保存しました。";
        const trainingStatus = document.getElementById("training-status");
        if (trainingStatus) trainingStatus.textContent = "別の端末から学習結果を引き継ぎました。";
        const trainingInfo = document.getElementById("training-info");
        if (trainingInfo) trainingInfo.textContent = "評価関数の重みを更新しました。";
      } catch (error) {
        transferStatus.textContent = "読み込みできませんでした：" + (error.message || String(error));
      }
    });
  }
  render();
})();