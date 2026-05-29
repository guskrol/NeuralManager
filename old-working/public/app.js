const state = {
  snapshot: null,
  launchQueueRunning: false,
  isEditingAccountRow: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function fillSettings(config) {
  $("#launcherPath").value = config.launcherPath || "";
  $("#defaultScriptName").value = config.defaultScriptName || "";
  $("#defaultWorld").value = config.defaultWorld || 301;
  $("#maxInstances").value = config.maxInstances || 1;
  $("#launchDelaySeconds").value = config.launchDelaySeconds || 0;
  $("#useGeneratedTotp").checked = Boolean(config.useGeneratedTotp);
}

function renderAccounts(snapshot) {
  const body = $("#accountsBody");
  body.innerHTML = "";
  const byIndex = new Map(snapshot.accounts.map((account) => [account.index, account]));
  const launchByIndex = new Map(snapshot.launches.map((launch) => [launch.index, launch]));
  const proxyOptions = buildProxyOptions(snapshot.proxies || []);

  for (const row of snapshot.rows) {
    const account = byIndex.get(row.index);
    const launch = launchByIndex.get(row.index);
    const summary = buildAccountSummary({ account, row, launch });
    const tr = document.createElement("tr");
    tr.classList.toggle("account-running", launch?.status === "Running");
    tr.dataset.index = row.index;
    tr.innerHTML = `
      <td><input class="row-enabled account-enabled-checkbox" type="checkbox" aria-label="Conta ativa" ${row.enabled ? "checked" : ""} /></td>
      <td>
        <span class="account-email">${account?.email || "(sem conta)"}</span>
        <span class="account-meta">index ${row.index} · senha ${account?.password || ""} · secret ${account?.totpSecret || ""}</span>
      </td>
      <td><input class="row-script" value="${escapeHtml(row.scriptName || "")}" /></td>
      <td><input class="row-args" value="${escapeHtml((row.scriptParams || []).join(" "))}" placeholder="args do script" /></td>
      <td>
        <div class="world-control">
          <select class="row-world-mode">
            ${buildWorldModeOptions(row.worldMode)}
          </select>
          <input class="row-world" type="number" min="1" value="${row.world || 301}" ${row.worldMode && row.worldMode !== "fixed" ? "disabled" : ""} />
        </div>
      </td>
      <td><select class="row-proxy">${proxyOptions(row.proxyId)}</select></td>
      <td>${account?.totpCode || ""}</td>
      <td>
        <div class="summary-wrap">
          <button class="icon-button account-summary" type="button" aria-label="Resumo da conta">👁</button>
          <div class="summary-popover" role="tooltip">
            ${summary}
          </div>
        </div>
      </td>
      <td>
        <div class="row-actions">
          <button class="ghost save-row" type="button">Salvar</button>
          <button class="primary launch-row" type="button">Launch</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  }

  if (!snapshot.rows.length) {
    body.innerHTML = `<tr><td colspan="9">Nenhuma conta configurada ainda.</td></tr>`;
  }
}

function buildWorldModeOptions(selectedMode = "fixed") {
  const modes = [
    ["fixed", "Fixo"],
    ["random-f2p", "Random F2P"],
    ["random-p2p", "Random P2P"],
  ];

  return modes
    .map(([value, label]) => `<option value="${value}"${value === selectedMode ? " selected" : ""}>${label}</option>`)
    .join("");
}

function buildProxyOptions(proxies) {
  return (selectedProxyId) => {
    const selected = String(selectedProxyId || "");
    const options = [`<option value="">Sem proxy</option>`];

    for (const proxy of proxies) {
      const disabled = proxy.enabled ? "" : " disabled";
      const label = proxy.enabled ? proxy.name : `${proxy.name} (inativo)`;
      const selectedAttr = proxy.id === selected ? " selected" : "";
      options.push(`<option value="${escapeHtml(proxy.id)}"${selectedAttr}${disabled}>${escapeHtml(label)}</option>`);
    }

    return options.join("");
  };
}

function buildAccountSummary({ account, row, launch }) {
  const args = (row.scriptParams || []).join(" ") || "-";
  const status = launch?.status || "Sem processo";
  const pid = launch?.pid ? `pid ${launch.pid}` : "-";
  const startedAt = launch?.startedAt ? new Date(launch.startedAt).toLocaleString() : "-";
  const world = worldLabelFor(row);

  return `
    <div class="summary-head">
      <strong>${escapeHtml(account?.email || "(sem conta)")}</strong>
      <span>${escapeHtml(status)}</span>
    </div>
    <div class="summary-grid">
      <span>Index</span><strong>${row.index}</strong>
      <span>Script</span><strong>${escapeHtml(row.scriptName || "-")}</strong>
      <span>ARG</span><strong>${escapeHtml(args)}</strong>
      <span>World</span><strong>${escapeHtml(world)}</strong>
      <span>Proxy</span><strong>${escapeHtml(proxyNameFor(row.proxyId) || "-")}</strong>
      <span>TOTP</span><strong>${escapeHtml(account?.totpCode || "-")}</strong>
      <span>Senha</span><strong>${escapeHtml(account?.password || "-")}</strong>
      <span>Secret</span><strong>${escapeHtml(account?.totpSecret || "-")}</strong>
      <span>Processo</span><strong>${escapeHtml(pid)}</strong>
      <span>Início</span><strong>${escapeHtml(startedAt)}</strong>
    </div>
  `;
}

function worldLabelFor(row) {
  if (row.worldMode === "random-f2p") return "Random F2P";
  if (row.worldMode === "random-p2p") return "Random P2P";
  return String(row.world || 301);
}

function proxyNameFor(proxyId) {
  const proxy = state.snapshot?.proxies?.find((item) => item.id === proxyId);
  return proxy?.name || "";
}

function renderProxies(proxies) {
  const body = $("#proxiesBody");
  body.innerHTML = "";

  for (const proxy of proxies || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(proxy.name)}</td>
      <td>${escapeHtml(proxy.host)}</td>
      <td>${proxy.port}</td>
      <td>${escapeHtml(proxy.username || "-")}</td>
      <td>${escapeHtml(proxy.password || "-")}</td>
      <td><span class="proxy-status ${proxy.enabled ? "" : "off"}">${proxy.enabled ? "Ativo" : "Inativo"}</span></td>
      <td>
        <div class="row-actions">
          <button class="danger delete-proxy" type="button" data-proxy-id="${escapeHtml(proxy.id)}">Remover</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  }

  if (!proxies?.length) {
    body.innerHTML = `<tr><td colspan="7">Nenhum proxy cadastrado ainda.</td></tr>`;
  }
}

function renderLaunches(launches) {
  const node = $("#launches");
  node.innerHTML = "";

  if (!launches.length) {
    node.innerHTML = `<p class="launch-meta">Nenhum processo lançado por este painel ainda.</p>`;
    return;
  }

  for (const item of launches) {
    const div = document.createElement("div");
    div.className = "launch-item";
    div.innerHTML = `
      <div>
        <p class="launch-title">${escapeHtml(item.email)}</p>
        <p class="launch-meta">pid ${item.pid} · ${escapeHtml(item.scriptName)} · world ${item.world} · ${item.status}</p>
      </div>
      <button class="danger stop-process" type="button" data-pid="${item.pid}" ${item.status !== "Running" ? "disabled" : ""}>Stop</button>
    `;
    node.appendChild(div);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function switchTab(targetId) {
  for (const button of $$(".tab-button")) {
    const isActive = button.dataset.tabTarget === targetId;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }

  for (const panel of $$(".tab-panel")) {
    const isActive = panel.id === targetId;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  }
}

async function loadState() {
  if (state.isEditingAccountRow) return;
  const snapshot = await api("/api/state");
  state.snapshot = snapshot;
  $("#agentStatus").textContent = "Online";
  $("#agentStatus").classList.add("ok");
  fillSettings(snapshot.config);
  renderAccounts(snapshot);
  renderProxies(snapshot.proxies);
  renderLaunches(snapshot.launches);
}

async function saveSettings(event) {
  event.preventDefault();
  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      launcherPath: $("#launcherPath").value,
      defaultScriptName: $("#defaultScriptName").value,
      defaultWorld: Number($("#defaultWorld").value),
      maxInstances: Number($("#maxInstances").value),
      launchDelaySeconds: Number($("#launchDelaySeconds").value),
      useGeneratedTotp: $("#useGeneratedTotp").checked,
    }),
  });
  toast("Configuração salva.");
  await loadState();
}

async function addAccount(event) {
  event.preventDefault();
  await api("/api/account", {
    method: "POST",
    body: JSON.stringify({
      email: $("#email").value,
      password: $("#password").value,
      totpSecret: $("#totpSecret").value,
    }),
  });
  event.target.reset();
  toast("Conta adicionada.");
  await loadState();
}

function renderBulkResult(result) {
  const node = $("#bulkResult");
  const lines = [
    `Linhas lidas: ${result.totalLines}`,
    `Adicionadas: ${result.added}`,
  ];

  if (result.duplicates?.length) {
    lines.push(`Duplicadas ignoradas: ${result.duplicates.length}`);
  }

  if (result.invalid?.length) {
    lines.push(`Inválidas: ${result.invalid.length}`);
    for (const item of result.invalid.slice(0, 5)) {
      lines.push(`Linha ${item.lineNumber}: ${item.error}`);
    }
    if (result.invalid.length > 5) {
      lines.push(`Mais ${result.invalid.length - 5} linha(s) inválida(s).`);
    }
  }

  node.textContent = lines.join("\n");
}

async function bulkImport(event) {
  event.preventDefault();
  const accountsText = $("#bulkAccounts").value;
  const result = await api("/api/accounts/bulk", {
    method: "POST",
    body: JSON.stringify({ accountsText }),
  });

  renderBulkResult(result);
  if (result.added > 0) {
    $("#bulkAccounts").value = "";
  }
  toast(`${result.added} conta(s) importada(s).`);
  await loadState();
}

function renderBulkProxyResult(result) {
  const node = $("#bulkProxyResult");
  const lines = [
    `Linhas lidas: ${result.totalLines}`,
    `Adicionados: ${result.added}`,
  ];

  if (result.duplicates?.length) {
    lines.push(`Duplicados ignorados: ${result.duplicates.length}`);
  }

  if (result.invalid?.length) {
    lines.push(`Inválidos: ${result.invalid.length}`);
    for (const item of result.invalid.slice(0, 5)) {
      lines.push(`Linha ${item.lineNumber}: ${item.error}`);
    }
    if (result.invalid.length > 5) {
      lines.push(`Mais ${result.invalid.length - 5} proxy(s) inválido(s).`);
    }
  }

  node.textContent = lines.join("\n");
}

async function addProxy(event) {
  event.preventDefault();
  await api("/api/proxy", {
    method: "POST",
    body: JSON.stringify({
      name: $("#proxyName").value,
      host: $("#proxyHost").value,
      port: Number($("#proxyPort").value),
      username: $("#proxyUsername").value,
      password: $("#proxyPassword").value,
      enabled: $("#proxyEnabled").checked,
    }),
  });
  event.target.reset();
  $("#proxyEnabled").checked = true;
  toast("Proxy adicionado.");
  await loadState();
}

async function bulkImportProxies(event) {
  event.preventDefault();
  const proxiesText = $("#bulkProxies").value;
  const result = await api("/api/proxies/bulk", {
    method: "POST",
    body: JSON.stringify({ proxiesText }),
  });

  renderBulkProxyResult(result);
  if (result.added > 0) {
    $("#bulkProxies").value = "";
  }
  toast(`${result.added} proxy(s) importado(s).`);
  await loadState();
}

async function deleteProxy(id) {
  await api("/api/proxy/delete", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  toast("Proxy removido.");
  await loadState();
}

async function saveRow(tr) {
  await api("/api/row", {
    method: "POST",
    body: JSON.stringify({
      index: Number(tr.dataset.index),
      scriptName: tr.querySelector(".row-script").value,
      scriptParams: tr.querySelector(".row-args").value,
      world: Number(tr.querySelector(".row-world").value),
      worldMode: tr.querySelector(".row-world-mode").value,
      proxyId: tr.querySelector(".row-proxy").value,
      enabled: tr.querySelector(".row-enabled").checked,
    }),
  });
  toast("Conta salva.");
  state.isEditingAccountRow = false;
  await loadState();
}

async function launchRow(index) {
  const launch = state.snapshot?.launches?.find((item) => item.index === index && item.status === "Running");
  if (launch) {
    toast("Essa conta já está rodando.");
    return;
  }

  await api("/api/launch", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
  toast("Launch enviado.");
  await loadState();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function launchAll() {
  if (!state.snapshot || state.launchQueueRunning) return;
  state.launchQueueRunning = true;
  $("#launchAllBtn").disabled = true;

  try {
    const enabled = state.snapshot.rows.filter((row) => row.enabled);
    const limit = Math.max(1, Number(state.snapshot.config.maxInstances || 1));
    const delay = Math.max(0, Number(state.snapshot.config.launchDelaySeconds || 0));
    const queue = enabled.slice(0, limit);

    for (let i = 0; i < queue.length; i += 1) {
      await launchRow(queue[i].index);
      if (i < queue.length - 1 && delay > 0) {
        toast(`Aguardando ${delay}s para o próximo launch.`);
        await sleep(delay * 1000);
      }
    }
  } finally {
    state.launchQueueRunning = false;
    $("#launchAllBtn").disabled = false;
    await loadState();
  }
}

async function stopProcess(pid) {
  await api("/api/stop", {
    method: "POST",
    body: JSON.stringify({ pid }),
  });
  toast("Processo parado.");
  await loadState();
}

document.addEventListener("click", async (event) => {
  const saveButton = event.target.closest(".save-row");
  const launchButton = event.target.closest(".launch-row");
  const stopButton = event.target.closest(".stop-process");
  const deleteProxyButton = event.target.closest(".delete-proxy");

  try {
    if (saveButton) {
      await saveRow(saveButton.closest("tr"));
    }
    if (launchButton) {
      await launchRow(Number(launchButton.closest("tr").dataset.index));
    }
    if (stopButton) {
      await stopProcess(Number(stopButton.dataset.pid));
    }
    if (deleteProxyButton) {
      await deleteProxy(deleteProxyButton.dataset.proxyId);
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("change", (event) => {
  const worldMode = event.target.closest(".row-world-mode");
  if (!worldMode) return;

  const input = worldMode.closest(".world-control").querySelector(".row-world");
  input.disabled = worldMode.value !== "fixed";
});

document.addEventListener("focusin", (event) => {
  if (event.target.closest("#accountsBody input, #accountsBody select")) {
    state.isEditingAccountRow = true;
  }
});

document.addEventListener("focusout", (event) => {
  if (!event.target.closest("#accountsBody input, #accountsBody select")) return;

  window.setTimeout(() => {
    state.isEditingAccountRow = Boolean(document.activeElement?.closest("#accountsBody input, #accountsBody select"));
  }, 0);
});

$("#settingsForm").addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
$("#accountForm").addEventListener("submit", (event) => addAccount(event).catch((error) => toast(error.message)));
$("#bulkImportForm").addEventListener("submit", (event) => bulkImport(event).catch((error) => toast(error.message)));
$("#proxyForm").addEventListener("submit", (event) => addProxy(event).catch((error) => toast(error.message)));
$("#bulkProxyForm").addEventListener("submit", (event) => bulkImportProxies(event).catch((error) => toast(error.message)));
$("#refreshBtn").addEventListener("click", () => loadState().catch((error) => toast(error.message)));
$("#launchAllBtn").addEventListener("click", () => launchAll().catch((error) => toast(error.message)));

for (const button of $$(".tab-button")) {
  button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
}

loadState().catch((error) => {
  $("#agentStatus").textContent = "Erro";
  toast(error.message);
});

window.setInterval(() => {
  loadState().catch(() => {});
}, 10000);
