(() => {
  "use strict";

  // Coordinates are displayed as file 1-9 and rank 1-9.
  // This prototype deliberately contains no assumed movement rules yet.
  const SIZE = 9;
  const boardElement = document.getElementById("board");
  const selectedElement = document.getElementById("selected");
  const infoElement = document.getElementById("cell-info");
  const clearButton = document.getElementById("clear-selection");
  let selected = null;

  const position = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => [])
  );

  function render() {
    boardElement.replaceChildren();
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "square" + (selected && selected.row === row && selected.col === col ? " selected" : "");
        button.setAttribute("aria-label", `${col + 1}-${row + 1} マス`);
        const coord = document.createElement("span");
        coord.className = "coord";
        coord.textContent = `${col + 1},${row + 1}`;
        button.append(coord);

        const stack = position[row][col];
        if (stack.length) button.append(document.createTextNode(stack.map(piece => piece.name).join("・")));

        button.addEventListener("click", () => {
          selected = { row, col };
          selectedElement.textContent = `${col + 1}-${row + 1}`;
          infoElement.textContent = stack.length
            ? `このマスには ${stack.length} 枚の駒があります。`
            : "このマスは空です。";
          render();
        });
        boardElement.append(button);
      }
    }
    if (!selected) selectedElement.textContent = "なし";
  }

  clearButton.addEventListener("click", () => {
    selected = null;
    selectedElement.textContent = "なし";
    infoElement.textContent = "盤面のマスをタップしてください。";
    render();
  });

  render();
})();
