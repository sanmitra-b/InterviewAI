import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// Default table model and allowed lifecycle states.
const DEFAULT_COLUMNS = ["Company", "Role", "Status", "Applied Date", "Notes"];
const STATUS_OPTIONS = ["Planned", "Applied", "Interview", "Offer", "Rejected", "Withdrawn"];
const RESERVED_COLUMNS = ["Status"];

const tableEl = document.getElementById("applications-table");
const statusEl = document.getElementById("tracker-status");
const addRowBtn = document.getElementById("add-row-btn");
const addColumnBtn = document.getElementById("add-column-btn");
const useTemplateBtn = document.getElementById("use-template-btn");
const exportCsvBtn = document.getElementById("export-csv-btn");
const importCsvBtn = document.getElementById("import-csv-btn");
const importCsvInput = document.getElementById("import-csv-input");

let currentUser = null;
let saveTimer = null;
let isLoaded = false;

const state = {
  columns: [...DEFAULT_COLUMNS],
  rows: []
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  await loadTracker();
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});

addRowBtn.addEventListener("click", () => {
  const newRow = {};
  state.columns.forEach((column) => {
    newRow[column] = column === "Status" ? "Planned" : "";
  });
  state.rows.push(newRow);
  renderTable();
  scheduleSave();
});

addColumnBtn.addEventListener("click", () => {
  const columnName = prompt("New column name:");
  if (!columnName) return;

  const trimmed = columnName.trim();
  if (!trimmed) return;

  const exists = state.columns.some((col) => col.toLowerCase() === trimmed.toLowerCase());
  if (exists) {
    setStatus("Column already exists.", "error");
    return;
  }

  state.columns.push(trimmed);
  state.rows.forEach((row) => {
    row[trimmed] = "";
  });

  renderTable();
  scheduleSave();
});

useTemplateBtn.addEventListener("click", async () => {
  const loaded = await loadTemplateFromProject();
  if (!loaded) {
    setStatus("Template file not found. Add applications_tracker.csv in project root.", "error");
    return;
  }
  normalizeRows();
  renderTable();
  await saveTracker("Template applied and saved.", "success");
});

exportCsvBtn.addEventListener("click", () => {
  if (!state.columns.length) {
    setStatus("Nothing to export.", "error");
    return;
  }

  const csvContent = buildCsv(state.columns, state.rows);
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "applications_tracker.csv";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);

  setStatus("CSV exported.", "success");
});

importCsvBtn.addEventListener("click", () => {
  importCsvInput.value = "";
  importCsvInput.click();
});

importCsvInput.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const file = target.files?.[0];
  if (!file) return;

  try {
    const content = await file.text();
    const parsed = parseCsv(content);

    if (!parsed.length || !parsed[0].length) {
      setStatus("CSV appears empty.", "error");
      return;
    }

    applyParsedCsvRows(parsed);
    normalizeRows();
    renderTable();
    await saveTracker("CSV imported and saved.", "success");
  } catch (error) {
    setStatus("Could not import this CSV file.", "error");
  }
});

async function loadTracker() {
  // Load tracker from Firestore; if missing, try CSV template fallback.
  setStatus("Loading your tracker...", "loading");
  try {
    const trackerRef = doc(db, "students", currentUser.uid, "applicationTracker", "main");
    const snap = await getDoc(trackerRef);

    if (snap.exists()) {
      const data = snap.data();
      state.columns = Array.isArray(data.columns) && data.columns.length > 0 ? data.columns : [...DEFAULT_COLUMNS];
      state.rows = Array.isArray(data.rows) ? data.rows : [];
      normalizeRows();
      setStatus("Tracker loaded.", "success");
    } else {
      const loadedTemplate = await loadTemplateFromProject();
      if (!loadedTemplate) {
        state.columns = [...DEFAULT_COLUMNS];
        state.rows = [];
      }
      setStatus("Tracker ready. Auto-save is enabled.", "success");
    }
  } catch (error) {
    setStatus("Failed to load tracker data.", "error");
  }

  isLoaded = true;
  renderTable();
}

function normalizeRows() {
  // Ensure every row matches current schema and has a valid status value.
  state.rows = state.rows.map((row) => {
    const normalized = {};
    state.columns.forEach((column) => {
      if (column === "Status") {
        const value = row[column];
        normalized[column] = STATUS_OPTIONS.includes(value) ? value : "Planned";
      } else {
        normalized[column] = row[column] ?? "";
      }
    });
    return normalized;
  });
}

function renderTable() {
  // Render table headers and rows from in-memory tracker state.
  const headerCells = state.columns.map((column, columnIndex) => {
    const canRemove = !RESERVED_COLUMNS.includes(column);
    const removeBtn = canRemove
      ? `<button type="button" class="table-remove-btn" data-action="remove-column" data-column-index="${columnIndex}"><i class="fa-solid fa-xmark"></i></button>`
      : "";
    return `<th><div class="table-head-cell"><span>${escapeHtml(column)}</span>${removeBtn}</div></th>`;
  }).join("");

  const bodyRows = state.rows.map((row, rowIndex) => {
    const cells = state.columns.map((column) => {
      const cellValue = row[column] ?? "";
      if (column === "Status") {
        return `
          <td>
            <select class="table-select" data-row-index="${rowIndex}" data-column="${escapeAttr(column)}">
              ${STATUS_OPTIONS.map((option) => `<option value="${escapeAttr(option)}" ${option === cellValue ? "selected" : ""}>${escapeHtml(option)}</option>`).join("")}
            </select>
          </td>
        `;
      }
      return `
        <td>
          <input
            type="text"
            class="table-input"
            value="${escapeAttr(String(cellValue))}"
            data-row-index="${rowIndex}"
            data-column="${escapeAttr(column)}"
          />
        </td>
      `;
    }).join("");

    return `
      <tr>
        ${cells}
        <td class="table-action-cell">
          <button type="button" class="table-remove-btn" data-action="remove-row" data-row-index="${rowIndex}"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  }).join("");

  tableEl.innerHTML = `
    <thead>
      <tr>
        ${headerCells}
        <th class="table-action-col">Action</th>
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
  `;
}

tableEl.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const rowIndex = Number(target.dataset.rowIndex);
  const column = target.dataset.column;

  if (!Number.isInteger(rowIndex) || !column || !state.rows[rowIndex]) return;

  state.rows[rowIndex][column] = target.value;
  scheduleSave();
});

tableEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;

  const rowIndex = Number(target.dataset.rowIndex);
  const column = target.dataset.column;

  if (!Number.isInteger(rowIndex) || !column || !state.rows[rowIndex]) return;

  state.rows[rowIndex][column] = target.value;
  scheduleSave();
});

tableEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest("button");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "remove-row") {
    const rowIndex = Number(button.dataset.rowIndex);
    if (!Number.isInteger(rowIndex) || !state.rows[rowIndex]) return;
    state.rows.splice(rowIndex, 1);
    renderTable();
    scheduleSave();
    return;
  }

  if (action === "remove-column") {
    const columnIndex = Number(button.dataset.columnIndex);
    if (!Number.isInteger(columnIndex) || !state.columns[columnIndex]) return;
    const columnName = state.columns[columnIndex];

    if (RESERVED_COLUMNS.includes(columnName)) return;

    state.columns.splice(columnIndex, 1);
    state.rows.forEach((row) => {
      delete row[columnName];
    });
    renderTable();
    scheduleSave();
  }
});

function scheduleSave() {
  // Debounced autosave to avoid writing on every keystroke.
  if (!isLoaded) return;
  setStatus("Saving...", "loading");

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(async () => {
    await saveTracker("Saved.", "success");
  }, 700);
}

async function saveTracker(successMsg, successType) {
  // Persist full tracker state to the student's document namespace.
  if (!currentUser) return;
  try {
    const trackerRef = doc(db, "students", currentUser.uid, "applicationTracker", "main");
    await setDoc(trackerRef, {
      columns: state.columns,
      rows: state.rows,
      updatedAt: serverTimestamp()
    }, { merge: true });

    setStatus(successMsg, successType);
  } catch (error) {
    setStatus("Could not save to Firebase. Check your connection and rules.", "error");
  }
}

function setStatus(message, type) {
  statusEl.textContent = message;
  if (type === "error") {
    statusEl.style.color = "#ff6b6b";
    return;
  }
  if (type === "success") {
    statusEl.style.color = "#4caf50";
    return;
  }
  statusEl.style.color = "#6c63ff";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function buildCsv(columns, rows) {
  // Convert table state into a CSV string for download/export.
  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) => {
    return columns.map((column) => csvEscape(row[column] ?? "")).join(",");
  });
  return [header, ...lines].join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');
  return `"${escaped}"`;
}

function parseCsv(content) {
  // Minimal CSV parser supporting quoted cells and escaped quotes.
  const rows = [];
  let currentRow = [];
  let currentCell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function dedupeColumns(columns) {
  const seen = new Map();
  return columns.map((columnRaw) => {
    const column = columnRaw.trim();
    const key = column.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return column;
    return `${column}_${count + 1}`;
  });
}

function ensureStatusColumn(columns) {
  const hasStatus = columns.some((column) => column.toLowerCase() === "status");
  if (hasStatus) {
    return columns.map((column) => (column.toLowerCase() === "status" ? "Status" : column));
  }
  return [...columns, "Status"];
}

function getCellByHeader(row, headers, headerName) {
  const index = headers.findIndex((header) => header.toLowerCase() === headerName.toLowerCase());
  if (index === -1) return "";
  return row[index] ?? "";
}

function applyParsedCsvRows(parsed) {
  // Convert parsed CSV matrix into normalized tracker state.
  const header = parsed[0].map((column) => column.trim()).filter((column) => column.length > 0);
  if (!header.length) {
    throw new Error("CSV header is invalid");
  }

  const uniqueHeader = dedupeColumns(header);
  const finalColumns = ensureStatusColumn(uniqueHeader);
  const dataRows = parsed.slice(1).filter((row) => row.some((cell) => String(cell).trim() !== ""));

  const finalRows = dataRows.map((row) => {
    const rowObject = {};
    finalColumns.forEach((column, index) => {
      if (column === "Status") {
        const rawStatus = getCellByHeader(row, uniqueHeader, "Status");
        rowObject[column] = STATUS_OPTIONS.includes(rawStatus) ? rawStatus : "Planned";
        return;
      }

      const value = index < uniqueHeader.length ? row[index] : "";
      rowObject[column] = value ?? "";
    });
    return rowObject;
  });

  state.columns = finalColumns;
  state.rows = finalRows;
}

async function loadTemplateFromProject() {
  // Load bundled CSV template from project root when requested.
  try {
    const response = await fetch("applications_tracker.csv", { cache: "no-store" });
    if (!response.ok) {
      return false;
    }

    const content = await response.text();
    const parsed = parseCsv(content);
    if (!parsed.length || !parsed[0].length) {
      return false;
    }

    applyParsedCsvRows(parsed);
    return true;
  } catch (error) {
    return false;
  }
}

