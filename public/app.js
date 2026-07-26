const state = {
  snapshot: null,
  launchQueueRunning: false,
  isEditingAccountRow: false,
  taskFormInitialized: false,
  showAllLaunches: false,
  queueStatusHideTimer: null,
  selectedAccountIndexes: new Set(),
  selectedCheckerIndexes: new Set(),
  checkerBulkRunning: false,
  checkerBulkCancelRequested: false,
  currentCheckerIndex: null,
  isLoadingState: false,
  aiAnalysis: null,
  accountFilters: {
    search: "",
    category: "",
    status: "",
    enabled: "",
    nick: "",
    checker: "",
  },
  checkerFilters: {
    search: "",
    category: "",
    status: "",
    enabled: "",
    nick: "",
    result: "",
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

function renderCheckerLog(result) {
  const output = $("#checkerLogOutput");
  if (!output) return;
  output.textContent = result?.text?.trim() || "Nenhum log do checker ainda.";
  const pathNode = $("#checkerLogPath");
  if (pathNode && result?.path) pathNode.textContent = result.path;
  output.scrollTop = output.scrollHeight;
}

async function loadCheckerLog() {
  renderCheckerLog(await api("/api/checker/log", { method: "GET" }));
}

async function clearCheckerLog() {
  renderCheckerLog(await api("/api/checker/log/clear", { method: "POST", body: JSON.stringify({}) }));
  toast("Log do checker limpo.");
}

async function writeCheckerLog(message, details = {}) {
  try {
    renderCheckerLog(await api("/api/checker/log", {
      method: "POST",
      body: JSON.stringify({ message, details }),
    }));
  } catch {
    // Logging must never interrupt the checker queue.
  }
}

function fillSettings(config) {
  $("#launcherPath").value = config.launcherPath || "";
  $("#tribotCliPath").value = config.tribotCliPath || "";
  $("#epicBotPath").value = config.epicBotPath || "";
  $("#epicBotPlatform").value = config.epicBot?.platform || "";
  $("#epicBotHeap").value = config.epicBot?.heap || "";
  $("#epicBotMaxHeap").value = config.epicBot?.maxHeap || "";
  $("#epicBotMouseProfile").value = config.epicBot?.mouseProfile || "";
  $("#epicBotCpuRendering").checked = config.epicBot?.cpuRendering !== false;
  $("#epicBotUseSavedProxyName").checked = Boolean(config.epicBot?.useSavedProxyName);
  $("#defaultScriptName").value = config.defaultScriptName || "";
  $("#defaultWorld").value = config.defaultWorld || 301;
  $("#maxInstances").value = config.maxInstances || 1;
  $("#launchDelaySeconds").value = config.launchDelaySeconds || 0;
  $("#useGeneratedTotp").checked = Boolean(config.useGeneratedTotp);
  $("#useJagexBrowserLogin").checked = config.useJagexBrowserLogin !== false;
  $("#jagexDebug").checked = Boolean(config.jagexDebug);
  $("#useStoredGameAccount").checked = config.useStoredGameAccount !== false;
  $("#discordWebhookUrl").value = config.discordWebhook?.url || "";
  $("#discordWebhookEnabled").checked = Boolean(config.discordWebhook?.enabled);
  $("#discordNotifyOnStop").checked = config.discordWebhook?.notifyOnStop !== false;
  $("#discordIncludeLogTail").checked = config.discordWebhook?.includeLogTail !== false;
  $("#aiEnabled").checked = Boolean(config.ai?.enabled);
  $("#aiModel").value = config.ai?.model || "gpt-5.6-luna";
  $("#aiOpenAiApiKey").value = "";
  $("#aiClearOpenAiApiKey").checked = false;
  $("#aiIncludeCheckerLog").checked = config.ai?.includeCheckerLog !== false;
  $("#aiIncludeLaunchLogs").checked = config.ai?.includeLaunchLogs !== false;
  const keyStatus = $("#aiKeyStatus");
  if (keyStatus) keyStatus.textContent = config.ai?.apiKeyConfigured ? "Chave configurada." : "Chave não configurada.";
}

function renderVersion(version) {
  $("#appVersion").textContent = `v${version || "0.0.0"}`;
}

function renderMachineUsage(performance) {
  const node = $("#machineUsage");
  const machine = performance?.machine;
  if (!machine) {
    node.className = "machine-badge";
    node.innerHTML = `<span>CPU --%</span><span>RAM --%</span>`;
    return;
  }
  node.className = `machine-badge ${machine.severity || "ok"}`;
  const memoryDetail = machine.memoryUsedGb && machine.memoryTotalGb
    ? `${machine.memoryUsedGb.toFixed(1)}/${machine.memoryTotalGb.toFixed(1)} GB`
    : `${machine.memoryPercent || 0}%`;
  node.title = `CPU ${machine.cpuPercent || 0}% · RAM ${memoryDetail}`;
  node.innerHTML = `
    <span>CPU <strong>${machine.cpuPercent || 0}%</strong></span>
    <span>RAM <strong>${machine.memoryPercent || 0}%</strong></span>
  `;
}

function renderAiControls(snapshot) {
  const config = snapshot?.config?.ai || {};
  const status = $("#aiConfigStatus");
  if (status) {
    if (!config.enabled) {
      status.textContent = "AI Analyst desativado na aba Config.";
    } else if (!config.apiKeyConfigured) {
      status.textContent = "OpenAI API key não configurada.";
    } else {
      status.textContent = `Pronto · ${config.model || "modelo padrão"}`;
    }
  }

  const accountSelect = $("#aiAccountIndex");
  if (accountSelect) {
    const previous = accountSelect.value;
    const accountsByIndex = new Map((snapshot.accounts || []).map((account) => [Number(account.index), account]));
    accountSelect.innerHTML = `<option value="">Nenhuma</option>`;
    for (const row of snapshot.rows || []) {
      const account = accountsByIndex.get(Number(row.index));
      const label = [
        `index ${row.index}`,
        account?.email || "",
        row.charName ? `Nick: ${row.charName}` : "",
      ].filter(Boolean).join(" · ");
      accountSelect.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(String(row.index))}">${escapeHtml(label)}</option>`);
    }
    accountSelect.value = [...accountSelect.options].some((option) => option.value === previous) ? previous : "";
  }

  const scope = $("#aiAnalysisScope")?.value || "panel";
  if (accountSelect) accountSelect.disabled = scope !== "account";
  renderAiAnalysisResult(state.aiAnalysis);
}

function severityLabel(value) {
  return {
    ok: "OK",
    info: "Info",
    warning: "Atenção",
    critical: "Crítico",
  }[value] || "Info";
}

function riskLabel(value) {
  return {
    low: "baixo",
    medium: "médio",
    high: "alto",
  }[value] || "médio";
}

function renderAiAnalysisResult(result) {
  const node = $("#aiAnalysisResult");
  if (!node) return;
  if (!result) {
    node.className = "ai-result empty";
    node.textContent = "Nenhuma análise executada ainda.";
    return;
  }

  const analysis = result.analysis || {};
  const usage = result.usage || {};
  node.className = `ai-result severity-${escapeHtml(analysis.severity || "info")}`;
  node.innerHTML = `
    <div class="ai-result-header">
      <div>
        <span class="checker-pill ${escapeHtml(analysis.severity || "info")}">${escapeHtml(severityLabel(analysis.severity))}</span>
        <strong>${escapeHtml(analysis.summary || "Sem resumo.")}</strong>
      </div>
      <span class="muted-text">${escapeHtml(result.model || "")} · ${escapeHtml(formatDateTime(result.createdAt))}</span>
    </div>
    <div class="ai-meta-row">
      <span>Confiança: ${Math.round(Number(analysis.confidence || 0) * 100)}%</span>
      <span>Contexto: ${escapeHtml(String(result.contextMeta?.accounts || 0))} conta(s), ${escapeHtml(String(result.contextMeta?.logSections || 0))} log(s)</span>
      ${usage.total_tokens ? `<span>Tokens: ${escapeHtml(String(usage.total_tokens))}</span>` : ""}
    </div>
    <div class="ai-result-grid">
      <section>
        <h3>Achados</h3>
        ${(analysis.keyFindings || []).length ? analysis.keyFindings.map((item) => `
          <article class="ai-card">
            <strong>${escapeHtml(item.title)}</strong>
            <p>${escapeHtml(item.detail)}</p>
            <small>${escapeHtml(item.evidence)}</small>
          </article>
        `).join("") : `<p class="muted-text">Nenhum achado relevante.</p>`}
      </section>
      <section>
        <h3>Ações sugeridas</h3>
        ${(analysis.suggestedActions || []).length ? analysis.suggestedActions.map((item) => `
          <article class="ai-card">
            <div class="ai-card-title">
              <strong>${escapeHtml(item.label)}</strong>
              <span class="risk-badge risk-${escapeHtml(item.risk || "medium")}">risco ${escapeHtml(riskLabel(item.risk))}</span>
            </div>
            <p>${escapeHtml(item.reason)}</p>
          </article>
        `).join("") : `<p class="muted-text">Nenhuma ação sugerida.</p>`}
      </section>
    </div>
    ${(analysis.affectedAccounts || []).length ? `
      <section class="ai-affected">
        <h3>Contas citadas</h3>
        <div class="ai-account-list">
          ${analysis.affectedAccounts.map((item) => `
            <div class="ai-account-row">
              <strong>#${escapeHtml(String(item.index))} ${escapeHtml(item.email || "")}</strong>
              <span>${escapeHtml(item.charName || "-")} · ${escapeHtml(item.status || "-")}</span>
              <small>${escapeHtml(item.reason || "")}</small>
            </div>
          `).join("")}
        </div>
      </section>
    ` : ""}
    ${analysis.nextQuestion ? `<p class="ai-next-question">${escapeHtml(analysis.nextQuestion)}</p>` : ""}
  `;
}

function isActiveLaunchStatus(status) {
  return status === "Running" || status === "Starting";
}

function renderDashboard(snapshot) {
  const visibleRows = getFilteredAccountRows(snapshot);
  const visibleIndexes = new Set(visibleRows.map((row) => Number(row.index)));
  const runningIndexes = new Set(snapshot.launches
    .filter((launch) => launch.status === "Running")
    .map((launch) => Number(launch.index))
    .filter((index) => visibleIndexes.has(index)));
  const running = runningIndexes.size;
  const stopped = visibleRows.filter((row) => !runningIndexes.has(Number(row.index))).length;
  const enabled = visibleRows.filter((row) => row.enabled).length;
  const activeTasks = snapshot.continuousTasks.filter((task) => task.enabled).length;
  const nextCheck = snapshot.continuous?.state?.nextCheckAt ? formatDateTime(snapshot.continuous.state.nextCheckAt) : "-";

  $("#dashboardStrip").innerHTML = `
    <div class="dashboard-card good">
      <span>Online</span>
      <strong>${running}</strong>
    </div>
    <div class="dashboard-card">
      <span>Contas ativas</span>
      <strong>${enabled}</strong>
    </div>
    <div class="dashboard-card">
      <span>Tasks ativas</span>
      <strong>${activeTasks}</strong>
    </div>
    <div class="dashboard-card ${stopped ? "warn" : ""}">
      <span>Parados</span>
      <strong>${stopped}</strong>
    </div>
    <div class="dashboard-card wide">
      <span>Próxima checagem</span>
      <strong>${escapeHtml(nextCheck)}</strong>
    </div>
  `;
  renderMachineUsage(snapshot.performance);
  renderPerformanceAlert(snapshot.performance);
}

function renderPerformanceAlert(performance) {
  const node = $("#performanceAlert");
  const jcef = performance?.jcef;
  if (!jcef || jcef.severity === "ok" || !jcef.count) {
    node.hidden = true;
    node.innerHTML = "";
    return;
  }

  const topProcesses = (jcef.processes || [])
    .slice(0, 6)
    .map((item) => `PID ${item.pid}${item.cpuPercent ? ` · ${item.cpuPercent.toFixed(1)}%` : ""}`)
    .join(" · ");

  node.hidden = false;
  node.className = `performance-alert ${jcef.severity}`;
  node.innerHTML = `
    <div>
      <span>Alerta JCEF</span>
      <strong>${jcef.count} processo(s) JCEF${jcef.cpuPercent ? ` · CPU aprox. ${jcef.cpuPercent.toFixed(1)}%` : ""}</strong>
      <p>${escapeHtml(topProcesses || "Finalize processos JCEF presos pelo Gerenciador de Tarefas.")}</p>
    </div>
    <button class="ghost" id="refreshPerformanceBtn" type="button">Atualizar</button>
  `;
}

function renderDiagnostics(diagnostics) {
  const node = $("#diagnosticsContent");
  const issues = diagnostics?.issues || [];
  const status = diagnostics?.status || "ok";
  const visibleIssues = issues.slice(0, 6);
  node.className = `diagnostics-panel ${status}`;
  node.innerHTML = `
    <div class="diagnostics-head">
      <div>
        <span>Diagnóstico</span>
        <strong>${escapeHtml(diagnostics?.summary || "Setup pronto para launch.")}</strong>
      </div>
      <button class="ghost" id="refreshDiagnosticsBtn" type="button">Revalidar</button>
    </div>
    ${visibleIssues.length ? `
      <div class="diagnostics-list">
        ${visibleIssues.map((issue) => `
          <div class="diagnostic-item ${escapeHtml(issue.severity)}">
            <span>${escapeHtml(issue.severity === "error" ? "Erro" : "Aviso")}</span>
            <strong>${escapeHtml(issue.message)}</strong>
          </div>
        `).join("")}
        ${issues.length > visibleIssues.length ? `<p class="launch-meta">+${issues.length - visibleIssues.length} aviso(s) oculto(s)</p>` : ""}
      </div>
    ` : ""}
  `;
}

function renderAccounts(snapshot) {
  const body = $("#accountsBody");
  body.innerHTML = "";
  const byIndex = new Map(snapshot.accounts.map((account) => [account.index, account]));
  const activityByIndex = buildAccountActivity(snapshot.launches || []);
  const proxyOptions = buildProxyOptions(snapshot.proxies || []);
  const categoryOptions = buildCategoryOptions(snapshot.categories || []);
  const checker = snapshot.checker || {};
  renderAccountFilterOptions(snapshot.categories || []);
  syncAccountFilterInputs();
  const filteredRows = getFilteredAccountRows(snapshot);

  $("#accountFilterCount").textContent = `${filteredRows.length} de ${snapshot.rows.length}`;

  for (const row of filteredRows) {
    const account = byIndex.get(row.index);
    const activity = activityByIndex.get(Number(row.index)) || accountActivityFallback(row);
    const checkerResult = checker[row.index];
    const totalLevel = Number(checkerResult?.totalLevel || 0) > 0 ? checkerResult.totalLevel : "-";
    const summary = buildAccountSummary({ account, row, activity });
    const tr = document.createElement("tr");
    const isRunning = activity.health === "online";
    tr.classList.toggle("account-running", isRunning);
    tr.classList.toggle("account-banned", !isRunning && checkerResult?.status === "banned");
    tr.dataset.index = row.index;
    tr.innerHTML = `
      <td><input class="row-selected account-select-checkbox" type="checkbox" aria-label="Selecionar conta" ${state.selectedAccountIndexes.has(Number(row.index)) ? "checked" : ""} /></td>
      <td>
        <span class="account-email">${account?.email || "(sem conta)"}</span>
        <span class="account-meta char-name-display">Nick: ${row.charName ? escapeHtml(row.charName) : "aguardando script"}</span>
        <input class="row-char-name" type="hidden" value="${escapeHtml(row.charName || "")}" />
      </td>
      <td><input class="row-notes" value="${escapeHtml(row.notes || "")}" placeholder="o que esta fazendo" /></td>
      <td>${renderAccountHealth(activity, row)}</td>
      <td>
        <span class="checker-pill compact ${escapeHtml(checkerStatusClass(checkerResult))}">${escapeHtml(checkerStatusLabel(checkerResult))}</span>
        ${checkerResult?.checkedAt ? `<span class="account-meta">${escapeHtml(formatDateTime(checkerResult.checkedAt))}</span>` : ""}
      </td>
      <td><strong class="checker-total-level">${escapeHtml(String(totalLevel))}</strong></td>
      <td><select class="row-category">${categoryOptions(row.category)}</select></td>
      <td><input class="row-script" value="${escapeHtml(row.scriptName || "")}" /></td>
      <td><input class="row-schedule" value="${escapeHtml(row.scheduleName || "")}" placeholder="schedule" /></td>
      <td><input class="row-args" value="${escapeHtml((row.scriptParams || []).join(" "))}" placeholder="args do script" /></td>
      <td><input class="row-epic-profile" value="${escapeHtml(row.epicBotProfilePath || "")}" placeholder="settings.json" /></td>
      <td>
        <div class="world-control">
          <select class="row-world-mode">
            ${buildWorldModeOptions(row.worldMode)}
          </select>
          <input class="row-world" type="number" min="1" value="${row.world || 301}" ${row.worldMode && row.worldMode !== "fixed" ? "disabled" : ""} />
        </div>
      </td>
      <td><select class="row-proxy">${proxyOptions(row.proxyId)}</select></td>
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
          <select class="row-launch-client" aria-label="Executor do launch">
            <option value="dreambot" ${row.botClient === "dreambot" ? "selected" : ""}>DreamBot</option>
            <option value="tribot" ${row.botClient === "tribot" ? "selected" : ""}>TRiBot</option>
            <option value="epicbot" ${row.botClient === "epicbot" ? "selected" : ""}>EpicBot</option>
          </select>
          <button class="primary launch-row" type="button">Launch</button>
          <button class="icon-button danger delete-account" type="button" aria-label="Excluir conta" title="Excluir conta">🗑</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  }

  if (!snapshot.rows.length) {
    body.innerHTML = `<tr><td colspan="15">Nenhuma conta configurada ainda.</td></tr>`;
  } else if (!filteredRows.length) {
    body.innerHTML = `<tr><td colspan="14">Nenhuma conta encontrada com os filtros atuais.</td></tr>`;
  }
  syncSelectAllAccounts();
}

function checkerStatusLabel(item) {
  if (!item) return "Não checada";
  if (item.status === "ok") return "Encontrada";
  if (item.status === "banned") return "Provável banida";
  if (item.status === "capturing") return "Capturando nick";
  if (item.status === "error") return "Erro";
  return item.status || "Não checada";
}

function checkerStatusClass(item) {
  return item?.status || "unchecked";
}

function getFilteredCheckerRows(snapshot) {
  if (!snapshot) return [];
  const byIndex = new Map((snapshot.accounts || []).map((account) => [account.index, account]));
  const activityByIndex = buildAccountActivity(snapshot.launches || []);
  const checker = snapshot.checker || {};
  return (snapshot.rows || []).filter((row) => {
    const account = byIndex.get(row.index);
    const activity = activityByIndex.get(Number(row.index)) || accountActivityFallback(row);
    const result = checker[row.index]?.status || "unchecked";
    if (state.checkerFilters.result && state.checkerFilters.result !== result) return false;
    return accountMatchesFilters({ row, account, activity, proxies: snapshot.proxies || [], filters: state.checkerFilters, checkerStatus: result });
  });
}

function renderChecker(snapshot) {
  const body = $("#checkerBody");
  if (!body) return;
  body.innerHTML = "";
  const byIndex = new Map(snapshot.accounts.map((account) => [account.index, account]));
  const activityByIndex = buildAccountActivity(snapshot.launches || []);
  const checker = snapshot.checker || {};
  renderCheckerFilterOptions(snapshot.categories || []);
  syncCheckerFilterInputs();
  const filteredRows = getFilteredCheckerRows(snapshot);
  $("#checkerFilterCount").textContent = `${filteredRows.length} de ${snapshot.rows.length}`;

  for (const row of filteredRows) {
    const account = byIndex.get(row.index);
    const activity = activityByIndex.get(Number(row.index)) || accountActivityFallback(row);
    const result = checker[row.index];
    const summary = buildAccountSummary({ account, row, activity });
    const totalLevel = Number(result?.totalLevel || 0) > 0 ? result.totalLevel : "-";
    const tr = document.createElement("tr");
    const isRunning = activity.health === "online";
    tr.classList.toggle("account-running", isRunning);
    tr.classList.toggle("account-banned", !isRunning && result?.status === "banned");
    tr.dataset.index = row.index;
    tr.innerHTML = `
      <td><input class="checker-row-selected account-select-checkbox" type="checkbox" aria-label="Selecionar conta no checker" ${state.selectedCheckerIndexes.has(Number(row.index)) ? "checked" : ""} /></td>
      <td>
        <span class="account-email">${escapeHtml(account?.email || "(sem conta)")}</span>
        <span class="account-meta">index ${row.index}</span>
      </td>
      <td>${row.charName ? escapeHtml(row.charName) : `<span class="muted-text">aguardando captura</span>`}</td>
      <td>${escapeHtml(row.category || "default")}</td>
      <td>${escapeHtml(row.scheduleName || row.scriptName || "-")}</td>
      <td>${renderAccountHealth(activity, row)}</td>
      <td><strong>${escapeHtml(String(totalLevel))}</strong></td>
      <td>
        <input class="row-char-name" type="hidden" value="${escapeHtml(row.charName || "")}" />
        <div class="summary-wrap">
          <button class="icon-button account-summary" type="button" aria-label="Resumo da conta">👁</button>
          <div class="summary-popover" role="tooltip">
            ${summary}
          </div>
        </div>
      </td>
      <td>
        <span class="checker-pill ${escapeHtml(checkerStatusClass(result))}">${escapeHtml(checkerStatusLabel(result))}</span>
        <span class="account-meta">${escapeHtml(result?.message || "")}</span>
        <span class="account-meta">${result?.checkedAt ? escapeHtml(formatDateTime(result.checkedAt)) : ""}</span>
      </td>
      <td><button class="primary check-account" type="button">CHECAR</button></td>
    `;
    body.appendChild(tr);
  }

  if (!snapshot.rows.length) {
    body.innerHTML = `<tr><td colspan="10">Nenhuma conta configurada ainda.</td></tr>`;
  } else if (!filteredRows.length) {
    body.innerHTML = `<tr><td colspan="10">Nenhuma conta encontrada com os filtros atuais.</td></tr>`;
  }
  syncSelectAllCheckerAccounts();
}

function getFilteredAccountRows(snapshot) {
  if (!snapshot) return [];
  const byIndex = new Map((snapshot.accounts || []).map((account) => [account.index, account]));
  const activityByIndex = buildAccountActivity(snapshot.launches || []);
  const checker = snapshot.checker || {};
  return (snapshot.rows || []).filter((row) => {
    const account = byIndex.get(row.index);
    const activity = activityByIndex.get(Number(row.index)) || accountActivityFallback(row);
    const checkerStatus = checker[row.index]?.status || "unchecked";
    return accountMatchesFilters({ row, account, activity, proxies: snapshot.proxies || [], filters: state.accountFilters, checkerStatus });
  });
}

function renderAccountFilterOptions(categories) {
  const select = $("#accountFilterCategory");
  const current = state.accountFilters.category;
  const values = [...new Set(categories.map((category) => String(category || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">Todas</option>${values.map((category) => `
    <option value="${escapeHtml(category)}">${escapeHtml(category)}</option>
  `).join("")}`;
  select.value = values.includes(current) ? current : "";
  state.accountFilters.category = select.value;
}

function renderCheckerFilterOptions(categories) {
  const select = $("#checkerFilterCategory");
  if (!select) return;
  const current = state.checkerFilters.category;
  const values = [...new Set(categories.map((category) => String(category || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">Todas</option>${values.map((category) => `
    <option value="${escapeHtml(category)}">${escapeHtml(category)}</option>
  `).join("")}`;
  select.value = values.includes(current) ? current : "";
  state.checkerFilters.category = select.value;
}

function syncAccountFilterInputs() {
  $("#accountSearch").value = state.accountFilters.search;
  $("#accountFilterCategory").value = state.accountFilters.category;
  $("#accountFilterStatus").value = state.accountFilters.status;
  $("#accountFilterEnabled").value = state.accountFilters.enabled;
  $("#accountFilterNick").value = state.accountFilters.nick;
  $("#accountFilterChecker").value = state.accountFilters.checker;
}

function syncCheckerFilterInputs() {
  $("#checkerSearch").value = state.checkerFilters.search;
  $("#checkerFilterCategory").value = state.checkerFilters.category;
  $("#checkerFilterStatus").value = state.checkerFilters.status;
  $("#checkerFilterEnabled").value = state.checkerFilters.enabled;
  $("#checkerFilterNick").value = state.checkerFilters.nick;
  $("#checkerFilterResult").value = state.checkerFilters.result;
}

function accountMatchesFilters({ row, account, activity, proxies, filters, checkerStatus = "" }) {
  if (filters.category && row.category !== filters.category) return false;
  if (filters.status && activity.health !== filters.status) return false;
  if (filters.enabled === "enabled" && !row.enabled) return false;
  if (filters.enabled === "disabled" && row.enabled) return false;
  if (filters.nick === "with" && !row.charName) return false;
  if (filters.nick === "without" && row.charName) return false;
  if (filters.checker && (checkerStatus || "unchecked") !== filters.checker) return false;

  const proxy = proxies.find((item) => item.id === row.proxyId);
  const haystack = [
    account?.email,
    row.charName,
    row.notes,
    row.category,
    row.scriptName,
    row.scheduleName,
    ...(row.scriptParams || []),
    row.world,
    row.worldMode,
    row.proxyId,
    proxy?.name,
    proxy?.host,
    activity.label,
    activity.detail,
    activity.health,
  ].join(" ").toLowerCase();

  const terms = filters.search
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  return terms.every((term) => haystack.includes(term));
}

function syncSelectAllAccounts() {
  const checkbox = $("#selectAllAccounts");
  const rows = $$("#accountsBody .row-selected");
  const checked = rows.filter((item) => item.checked).length;
  checkbox.checked = rows.length > 0 && checked === rows.length;
  checkbox.indeterminate = checked > 0 && checked < rows.length;
  checkbox.disabled = rows.length === 0;
  syncBulkAccountBar(checked);
}

function selectedAccountRows() {
  return $$("#accountsBody tr[data-index]").filter((tr) => tr.querySelector(".row-selected")?.checked);
}

function clearAccountSelection() {
  state.selectedAccountIndexes.clear();
  for (const checkbox of $$("#accountsBody .row-selected")) {
    checkbox.checked = false;
  }
  syncSelectAllAccounts();
}

function selectedCheckerRows() {
  return $$("#checkerBody tr[data-index]").filter((tr) => tr.querySelector(".checker-row-selected")?.checked);
}

function setAccountSelected(index, selected) {
  const parsed = Number(index);
  if (!Number.isInteger(parsed)) return;
  if (selected) {
    state.selectedAccountIndexes.add(parsed);
  } else {
    state.selectedAccountIndexes.delete(parsed);
  }
}

function setCheckerSelected(index, selected) {
  const parsed = Number(index);
  if (!Number.isInteger(parsed)) return;
  if (selected) {
    state.selectedCheckerIndexes.add(parsed);
  } else {
    state.selectedCheckerIndexes.delete(parsed);
  }
}

function syncBulkAccountBar(selectedCount = selectedAccountRows().length) {
  const bar = $("#bulkAccountBar");
  bar.hidden = selectedCount === 0;
  $("#bulkAccountCount").textContent = `${selectedCount} selecionada(s)`;
}

function syncCheckerBulkBar(selectedCount = selectedCheckerRows().length) {
  const bar = $("#checkerBulkBar");
  if (!bar) return;
  bar.hidden = selectedCount === 0;
  $("#checkerBulkCount").textContent = `${selectedCount} selecionada(s)`;
  const button = $("#checkSelectedAccountsBtn");
  if (button) button.disabled = state.checkerBulkRunning || selectedCount === 0;
  const stopButton = $("#stopCheckerQueueBtn");
  if (stopButton) stopButton.disabled = !state.checkerBulkRunning;
}

function syncSelectAllCheckerAccounts() {
  const checkbox = $("#selectAllCheckerAccounts");
  if (!checkbox) return;
  const rows = $$("#checkerBody .checker-row-selected");
  const checked = rows.filter((item) => item.checked).length;
  checkbox.checked = rows.length > 0 && checked === rows.length;
  checkbox.indeterminate = checked > 0 && checked < rows.length;
  checkbox.disabled = rows.length === 0 || state.checkerBulkRunning;
  syncCheckerBulkBar(checked);
}

function buildAccountActivity(launches) {
  const byIndex = new Map();
  const sorted = launches
    .slice()
    .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));

  for (const launch of sorted) {
    const index = Number(launch.index);
    const current = byIndex.get(index) || { latest: null, running: null };
    if (!current.latest) current.latest = launch;
    if (!current.running && launch.status === "Running") current.running = launch;
    if (!current.starting && launch.status === "Starting") current.starting = launch;
    byIndex.set(index, current);
  }

  for (const [index, activity] of byIndex) {
    byIndex.set(index, enrichAccountActivity(activity));
  }

  return byIndex;
}

function accountActivityFallback(row) {
  return enrichAccountActivity({ latest: null, running: null, row });
}

function enrichAccountActivity(activity) {
  const launch = activity.running || activity.starting || activity.latest;
  if (activity.running) {
    return {
      ...activity,
      health: "online",
      label: "Online",
      detail: launch.stage || "Cliente online",
      lastLaunchAt: activity.latest?.startedAt || launch.startedAt || "",
    };
  }

  if (activity.starting) {
    return {
      ...activity,
      health: "starting",
      label: "Iniciando",
      detail: launch.stage || "Aguardando client DreamBot",
      lastLaunchAt: activity.latest?.startedAt || launch.startedAt || "",
    };
  }

  if (!activity.latest) {
    return {
      ...activity,
      health: "idle",
      label: "Nunca ligada",
      detail: "Sem launch registrado",
      lastLaunchAt: "",
    };
  }

  const stage = String(activity.latest.stage || "");
  const hasError = /erro|falha|invalid|error/i.test(stage);
  return {
    ...activity,
    health: hasError ? "warning" : "stopped",
    label: hasError ? "Atenção" : "Parada",
    detail: stage || activity.latest.status || "Parada ou desconhecida",
    lastLaunchAt: activity.latest.startedAt || "",
  };
}

function renderAccountHealth(activity, row) {
  const disabledLabel = row.enabled ? "" : `<span class="account-health-disabled">Desabilitada</span>`;
  return `
    <div class="account-health account-health-${activity.health}">
      <strong>${escapeHtml(activity.label)}</strong>
      <span>${escapeHtml(activity.lastLaunchAt ? `Último: ${formatDateTime(activity.lastLaunchAt)}` : activity.detail)}</span>
      ${disabledLabel}
    </div>
  `;
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

function buildCategoryOptions(categories) {
  return (selectedCategory) => {
    const selected = String(selectedCategory || "default");
    const values = categories?.length ? categories : ["default"];
    return values
      .map((category) => `<option value="${escapeHtml(category)}"${category === selected ? " selected" : ""}>${escapeHtml(category)}</option>`)
      .join("");
  };
}

function buildAccountSummary({ account, row, activity }) {
  return `
    <div class="summary-head">
      <strong>${escapeHtml(row.charName || account?.email || "(sem conta)")}</strong>
      <div class="summary-head-actions">
        <span>Stats</span>
        <button class="icon-button refresh-summary-stats" type="button" data-index="${row.index}" title="Atualizar">↻</button>
      </div>
    </div>
    <div class="summary-stats" data-index="${row.index}" data-char-name="${escapeHtml(row.charName || "")}">
      ${row.charName
        ? `<div class="stats-loading">Passe o mouse para carregar stats de ${escapeHtml(row.charName)}.</div>`
        : `<div class="stats-loading">Aguardando char name do script.</div>`}
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
  $("#activeLaunchesOnlyBtn").classList.toggle("active", !state.showAllLaunches);
  $("#showAllLaunchesBtn").classList.toggle("active", state.showAllLaunches);

  const sorted = launches
    .slice()
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
  const visibleLaunches = state.showAllLaunches
    ? sorted
    : sorted.filter((item, index) => isActiveLaunchStatus(item.status) || index < 5);

  if (!visibleLaunches.length) {
    node.innerHTML = `<p class="launch-meta">Nenhum processo lançado por este painel ainda.</p>`;
    return;
  }

  for (const item of visibleLaunches) {
    const div = document.createElement("div");
    div.className = "launch-item";
    div.classList.toggle("launch-stopped", !isActiveLaunchStatus(item.status));
    const visiblePid = item.effectivePid || item.pid;
    div.innerHTML = `
      <div>
        <p class="launch-title">${escapeHtml(item.email)}</p>
        <p class="launch-meta">pid ${visiblePid} · ${escapeHtml(item.taskName || item.scheduleName || item.scriptName)} · world ${item.world} · ${item.status} · ${escapeHtml(item.stage || "-")} · ${escapeHtml(formatDateTime(item.startedAt))}</p>
      </div>
      <div class="row-actions">
        <button class="ghost view-launch-log" type="button" data-pid="${item.pid}">Log</button>
        <button class="danger stop-process" type="button" data-pid="${visiblePid}" ${!isActiveLaunchStatus(item.status) ? "disabled" : ""}>Stop</button>
      </div>
    `;
    node.appendChild(div);
  }

  if (!state.showAllLaunches && sorted.length > visibleLaunches.length) {
    const hidden = document.createElement("p");
    hidden.className = "launch-meta";
    hidden.textContent = `${sorted.length - visibleLaunches.length} processo(s) antigo(s) oculto(s). Use Todos ou Limpar parados.`;
    node.appendChild(hidden);
  }
}

function renderLaunchLog(result) {
  const node = $("#launchLogViewer");
  node.hidden = false;
  node.innerHTML = `
    <div class="section-title compact-title">
      <h2>Log pid ${escapeHtml(result.pid)}</h2>
      <button class="ghost close-launch-log" type="button">Fechar</button>
    </div>
    <div class="log-viewer-body">
      <p class="launch-meta">${escapeHtml(result.email)} · ${escapeHtml(result.scheduleName || result.scriptName || "-")} · ${escapeHtml(result.status)}</p>
      <label>
        Comando
        <pre>${escapeHtml(result.commandPreview || "-")}</pre>
      </label>
      <label>
        Launcher stdout (${escapeHtml(result.stdoutPath || "-")})
        <pre>${escapeHtml(result.stdout || "-")}</pre>
      </label>
      <label>
        Launcher stderr (${escapeHtml(result.stderrPath || "-")})
        <pre>${escapeHtml(result.stderr || "-")}</pre>
      </label>
      <label>
        DreamBot log (${escapeHtml(result.dreamBotLogPath || "-")})
        <pre>${escapeHtml(result.dreamBotLog || "-")}</pre>
      </label>
    </div>
  `;
}

const statTiles = [
  ["attack", "Attack_icon.png"],
  ["defence", "Defence_icon.png"],
  ["ranged", "Ranged_icon.png"],
  ["strength", "Strength_icon.png"],
  ["agility", "Agility_icon.png"],
  ["woodcutting", "Woodcutting_icon.png"],
  ["hitpoints", "Hitpoints_icon.png"],
  ["herblore", "Herblore_icon.png"],
  ["fletching", "Fletching_icon.png"],
  ["prayer", "Prayer_icon.png"],
  ["mining", "Mining_icon.png"],
  ["firemaking", "Firemaking_icon.png"],
  ["magic", "Magic_icon.png"],
  ["thieving", "Thieving_icon.png"],
  ["farming", "Farming_icon.png"],
  ["cooking", "Cooking_icon.png"],
  ["runecraft", "Runecraft_icon.png"],
  ["construction", "Construction_icon.png"],
  ["fishing", "Fishing_icon.png"],
  ["crafting", "Crafting_icon.png"],
  ["hunter", "Hunter_icon.png"],
  ["smithing", "Smithing_icon.png"],
  ["slayer", "Slayer_icon.png"],
];

const completionSkillOptions = [
  ["", "Sem meta"],
  ["attack", "Attack"],
  ["strength", "Strength"],
  ["defence", "Defence"],
  ["ranged", "Ranged"],
  ["magic", "Magic"],
  ["hitpoints", "Hitpoints"],
  ["prayer", "Prayer"],
  ["cooking", "Cooking"],
  ["woodcutting", "Woodcutting"],
  ["fletching", "Fletching"],
  ["fishing", "Fishing"],
  ["firemaking", "Firemaking"],
  ["crafting", "Crafting"],
  ["smithing", "Smithing"],
  ["mining", "Mining"],
  ["herblore", "Herblore"],
  ["agility", "Agility"],
  ["thieving", "Thieving"],
  ["slayer", "Slayer"],
  ["farming", "Farming"],
  ["runecraft", "Runecraft"],
  ["hunter", "Hunter"],
  ["construction", "Construction"],
  ["overall", "Total level"],
  ["combat", "Combat"],
];

function osrsIcon(filename, alt) {
  const src = `https://oldschool.runescape.wiki/images/${encodeURIComponent(filename)}`;
  return `<img class="osrs-skill-icon" src="${src}" alt="${escapeHtml(alt)}" loading="lazy" />`;
}

function skillLevelText(stats, skill) {
  const value = Number(stats?.skills?.[skill]?.level ?? -1);
  return value >= 0 ? String(value) : "-";
}

function renderStatsBlock(stats, index) {
  const updated = stats.updatedAt ? formatDateTime(stats.updatedAt) : "-";
  return `
    <div class="stats-grid">
      ${statTiles.map(([skill, icon]) => `
        <div class="stat-tile" title="${escapeHtml(skill)}">
          <span>${osrsIcon(icon, skill)}</span>
          <strong>${escapeHtml(skillLevelText(stats, skill))}</strong>
        </div>
      `).join("")}
    </div>
    <div class="stats-footer">
      <div><span>${osrsIcon("Stats_icon.png", "total")}</span><strong>${escapeHtml(String(stats.totalLevel ?? "-"))}</strong></div>
      <div><span>${osrsIcon("Quest_point_icon.png", "quest points")}</span><strong>-</strong></div>
      <div><span>${osrsIcon("Combat_icon.png", "combat")}</span><strong>${escapeHtml(String(stats.combatLevel ?? "-"))}</strong></div>
    </div>
    <p class="stats-updated">${stats.cached ? "Cache" : "Atualizado"} · ${escapeHtml(updated)}</p>
  `;
}

async function loadSummaryStats(tr, refresh = false) {
  const charName = tr.querySelector(".row-char-name").value.trim();
  const node = tr.querySelector(".summary-stats");
  if (!node || node.dataset.loading === "true") return;
  if (!charName) {
    node.innerHTML = `<div class="stats-loading">Aguardando char name do script.</div>`;
    return;
  }

  if (!refresh && node.dataset.loadedFor === charName) return;

  node.dataset.loading = "true";
  node.innerHTML = `<div class="stats-loading">Buscando stats de ${escapeHtml(charName)}...</div>`;
  try {
    const stats = await api("/api/hiscores", {
      method: "POST",
      body: JSON.stringify({ player: charName, refresh }),
    });
    node.innerHTML = renderStatsBlock(stats, tr.dataset.index);
    node.dataset.loadedFor = charName;
  } catch (error) {
    node.innerHTML = `<div class="stats-loading">${escapeHtml(error.message)}</div>`;
  } finally {
    node.dataset.loading = "false";
  }
}

function positionSummaryPopover(wrap) {
  const button = wrap?.querySelector(".account-summary");
  const popover = wrap?.querySelector(".summary-popover");
  if (!button || !popover) return;

  const rect = button.getBoundingClientRect();
  const viewportPadding = 16;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
  const preferredHeight = Math.min(520, Math.max(260, popover.scrollHeight || 320), window.innerHeight - viewportPadding * 2);
  const openUp = rect.bottom + 8 + preferredHeight > window.innerHeight && rect.top > preferredHeight;
  const left = Math.max(viewportPadding, Math.min(window.innerWidth - width - viewportPadding, rect.right - width));
  const top = openUp
    ? Math.max(viewportPadding, rect.top - preferredHeight - 8)
    : Math.min(window.innerHeight - preferredHeight - viewportPadding, rect.bottom + 8);

  popover.style.position = "fixed";
  popover.style.left = `${left}px`;
  popover.style.right = "auto";
  popover.style.top = `${Math.max(viewportPadding, top)}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${window.innerHeight - viewportPadding * 2}px`;
  popover.style.zIndex = "10000";
}

function clearSummaryPopoverPosition(wrap) {
  const popover = wrap?.querySelector(".summary-popover");
  if (!popover) return;
  for (const property of ["position", "left", "right", "top", "width", "maxHeight", "zIndex"]) {
    popover.style[property] = "";
  }
}

function clearAllSummaryPopovers() {
  $$(".summary-wrap").forEach(clearSummaryPopoverPosition);
}

function renderContinuous(snapshot) {
  const continuous = snapshot.continuous || {};
  const config = continuous.config || {};
  const continuousState = continuous.state || {};
  $("#continuousEnabled").checked = Boolean(config.enabled);
  $("#continuousCheckInterval").value = config.checkIntervalSeconds || 30;
  $("#continuousStatus").textContent = continuousState.running ? "Rodando" : config.enabled ? "Pausado" : "Desligado";
  $("#continuousLastCheck").textContent = formatDateTime(continuousState.lastCheckAt);
  $("#continuousNextCheck").textContent = formatDateTime(continuousState.nextCheckAt);

  renderCategoryControls(snapshot.categories || []);
  renderTaskProxyOptions(snapshot.proxies || []);
  renderContinuousTasks(snapshot.continuousTasks || []);
  renderContinuousLogs(continuousState.logs || []);
  if (!state.taskFormInitialized) {
    resetTaskForm();
    state.taskFormInitialized = true;
  }
}

function renderCategoryControls(categories) {
  const safeCategories = categories?.length ? categories : ["default"];
  for (const select of [$("#accountCategory"), $("#bulkAccountCategory"), $("#taskCategory")]) {
    const selected = select.value || "default";
    select.innerHTML = safeCategories
      .map((category) => `<option value="${escapeHtml(category)}"${category === selected ? " selected" : ""}>${escapeHtml(category)}</option>`)
      .join("");
    if (!safeCategories.includes(select.value)) {
      select.value = safeCategories.includes(selected) ? selected : safeCategories[0];
    }
  }
  const bulkCategory = $("#bulkCategory");
  if (bulkCategory) {
    const selected = bulkCategory.value || "";
    bulkCategory.innerHTML = `<option value="">Categoria</option>${safeCategories
      .map((category) => `<option value="${escapeHtml(category)}"${category === selected ? " selected" : ""}>${escapeHtml(category)}</option>`)
      .join("")}`;
    bulkCategory.value = selected && safeCategories.includes(selected) ? selected : "";
  }
  const moveSelect = $("#taskMoveToCategory");
  if (moveSelect) {
    const selected = moveSelect.value || "";
    moveSelect.innerHTML = `<option value="">Não mover</option>${safeCategories
      .map((category) => `<option value="${escapeHtml(category)}"${category === selected ? " selected" : ""}>${escapeHtml(category)}</option>`)
      .join("")}`;
    moveSelect.value = selected && safeCategories.includes(selected) ? selected : "";
  }
  renderCompletionSkillOptions();
  renderCategoriesList(safeCategories);
}

function renderCompletionSkillOptions() {
  const select = $("#taskCompletionSkill");
  if (!select) return;
  const selected = select.value || "";
  select.innerHTML = completionSkillOptions
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
  select.value = completionSkillOptions.some(([value]) => value === selected) ? selected : "";
}

function renderCategoriesList(categories) {
  const node = $("#categoriesList");
  node.innerHTML = "";
  for (const category of categories) {
    const rowCount = state.snapshot?.rows?.filter((row) => row.category === category).length || 0;
    const taskCount = state.snapshot?.continuousTasks?.filter((task) => task.category === category).length || 0;
    const item = document.createElement("div");
    item.className = "category-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(category)}</strong>
        <span>${rowCount} conta(s) · ${taskCount} task(s)</span>
      </div>
      <button class="danger delete-category" type="button" data-category="${escapeHtml(category)}" ${category === "default" ? "disabled" : ""}>Remover</button>
    `;
    node.appendChild(item);
  }
}

function renderTaskProxyOptions(proxies) {
  const select = $("#taskProxyId");
  const selected = select.value;
  select.innerHTML = `<option value="">Sem proxy</option>`;
  for (const proxy of proxies) {
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = proxy.enabled ? proxy.name : `${proxy.name} (inativo)`;
    option.disabled = !proxy.enabled;
    select.appendChild(option);
  }
  select.value = selected;
}

function renderContinuousTasks(tasks) {
  const body = $("#continuousTasksBody");
  body.innerHTML = "";

  for (const task of tasks) {
    const tr = document.createElement("tr");
    tr.dataset.taskId = task.id;
    tr.innerHTML = `
      <td><span class="proxy-status ${task.enabled ? "" : "off"}">${task.enabled ? "Ativa" : "Pausada"}</span></td>
      <td>${escapeHtml(task.name)}</td>
      <td>${escapeHtml(task.category)}</td>
      <td>${escapeHtml(task.scriptName)}</td>
      <td>${escapeHtml(task.scheduleName || "-")}</td>
      <td>${escapeHtml((task.scriptParams || []).join(" ") || "-")}</td>
      <td>${escapeHtml(task.epicBotProfilePath || "-")}</td>
      <td>${escapeHtml(proxyLabelForTask(task))}</td>
      <td>${escapeHtml(taskGoalLabel(task))}</td>
      <td>${escapeHtml(task.moveToCategoryOnComplete || "-")}</td>
      <td>${task.maxInstances}</td>
      <td>${task.cooldownMinutes}min</td>
      <td>
        <div class="row-actions">
          <button class="ghost edit-task" type="button">Editar</button>
          <button class="ghost apply-task" type="button">Aplicar</button>
          <button class="ghost toggle-task" type="button">${task.enabled ? "Pausar" : "Ativar"}</button>
          <button class="danger delete-task" type="button">Remover</button>
        </div>
      </td>
    `;
    body.appendChild(tr);
  }

  if (!tasks.length) {
    body.innerHTML = `<tr><td colspan="13">Nenhuma continuous task criada ainda.</td></tr>`;
  }
}

function taskGoalLabel(task) {
  if (!task.completionSkill || !task.completionLevel) return "-";
  const option = completionSkillOptions.find(([value]) => value === task.completionSkill);
  return `${option?.[1] || task.completionSkill} >= ${task.completionLevel}`;
}

function renderContinuousLogs(logs) {
  const node = $("#continuousLogs");
  if (!logs.length) {
    node.innerHTML = `<p class="launch-meta">Nenhuma decisão registrada ainda.</p>`;
    return;
  }

  node.innerHTML = logs
    .slice()
    .reverse()
    .map((item) => `
      <div class="log-line">
        <span>${escapeHtml(formatDateTime(item.at))}</span>
        <strong>${escapeHtml(item.message)}${item.count > 1 ? ` (${item.count}x)` : ""}</strong>
      </div>
    `)
    .join("");
}

function proxyLabelForTask(task) {
  if (task.proxyMode === "none") return "Sem proxy";
  if (task.proxyMode === "account") return "Proxy da conta";
  return proxyNameFor(task.proxyId) || "Proxy da task";
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : "-";
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
  if (targetId === "checkerPanel") {
    loadCheckerLog().catch(() => {});
  }
}

function activeTabId() {
  return $(".tab-panel.active")?.id || "accountsPanel";
}

async function loadState() {
  if (state.isEditingAccountRow) return;
  if (state.isLoadingState) return;
  state.isLoadingState = true;
  try {
    const snapshot = await api("/api/state");
    state.snapshot = snapshot;
    $("#agentStatus").textContent = "Online";
    $("#agentStatus").classList.add("ok");
    renderVersion(snapshot.version);
    renderDashboard(snapshot);
    renderDiagnostics(snapshot.diagnostics);
    fillSettings(snapshot.config);
    renderAccounts(snapshot);
    renderChecker(snapshot);
    renderAiControls(snapshot);
    renderProxies(snapshot.proxies);
    renderLaunches(snapshot.launches);
    renderContinuous(snapshot);
    if (activeTabId() === "checkerPanel") {
      loadCheckerLog().catch(() => {});
    }
  } finally {
    state.isLoadingState = false;
  }
}

async function refreshStatePreservingTab(targetId = activeTabId()) {
  await loadState();
  switchTab(targetId);
}

async function saveSettings(event) {
  event.preventDefault();
  await api("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      launcherPath: $("#launcherPath").value,
      tribotCliPath: $("#tribotCliPath").value,
      epicBotPath: $("#epicBotPath").value,
      epicBotPlatform: $("#epicBotPlatform").value,
      epicBotHeap: $("#epicBotHeap").value,
      epicBotMaxHeap: $("#epicBotMaxHeap").value,
      epicBotMouseProfile: $("#epicBotMouseProfile").value,
      epicBotCpuRendering: $("#epicBotCpuRendering").checked,
      epicBotUseSavedProxyName: $("#epicBotUseSavedProxyName").checked,
      defaultScriptName: $("#defaultScriptName").value,
      defaultWorld: Number($("#defaultWorld").value),
      maxInstances: Number($("#maxInstances").value),
      launchDelaySeconds: Number($("#launchDelaySeconds").value),
      useGeneratedTotp: $("#useGeneratedTotp").checked,
      useJagexBrowserLogin: $("#useJagexBrowserLogin").checked,
      jagexDebug: $("#jagexDebug").checked,
      useStoredGameAccount: $("#useStoredGameAccount").checked,
      discordWebhookUrl: $("#discordWebhookUrl").value,
      discordWebhookEnabled: $("#discordWebhookEnabled").checked,
      discordNotifyOnStop: $("#discordNotifyOnStop").checked,
      discordIncludeLogTail: $("#discordIncludeLogTail").checked,
      aiEnabled: $("#aiEnabled").checked,
      aiModel: $("#aiModel").value,
      aiOpenAiApiKey: $("#aiOpenAiApiKey").value,
      aiClearOpenAiApiKey: $("#aiClearOpenAiApiKey").checked,
      aiIncludeCheckerLog: $("#aiIncludeCheckerLog").checked,
      aiIncludeLaunchLogs: $("#aiIncludeLaunchLogs").checked,
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
      category: $("#accountCategory").value,
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
    body: JSON.stringify({
      accountsText,
      category: $("#bulkAccountCategory").value,
    }),
  });

  renderBulkResult(result);
  if (result.added > 0) {
    $("#bulkAccounts").value = "";
  }
  toast(`${result.added} conta(s) importada(s).`);
  await loadState();
}

async function exportAccounts() {
  const indexes = selectedAccountRows().map((tr) => Number(tr.dataset.index));
  if (!indexes.length) {
    toast("Selecione ao menos uma conta para exportar.");
    return;
  }
  const result = await api("/api/accounts/export", {
    method: "POST",
    body: JSON.stringify({ indexes }),
  });
  const blob = new Blob([result.content || ""], { type: "text/plain;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = result.filename || "neural-accounts.txt";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
  toast(`${result.exported || indexes.length} conta(s) exportada(s).`);
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

async function addCategory(event) {
  event.preventDefault();
  await api("/api/category", {
    method: "POST",
    body: JSON.stringify({ name: $("#categoryName").value }),
  });
  event.target.reset();
  toast("Categoria adicionada.");
  await loadState();
}

async function deleteCategory(name) {
  await api("/api/category/delete", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  toast("Categoria removida.");
  await loadState();
}

async function persistRow(tr) {
  await api("/api/row", {
    method: "POST",
    body: JSON.stringify(rowPayload(tr)),
  });
}

function rowPayload(tr) {
  const index = Number(tr.dataset.index);
  const existingRow = state.snapshot?.rows?.find((row) => Number(row.index) === index);
  return {
    index,
    charName: tr.querySelector(".row-char-name").value,
    notes: tr.querySelector(".row-notes").value,
    category: tr.querySelector(".row-category").value,
    scriptName: tr.querySelector(".row-script").value,
    scheduleName: tr.querySelector(".row-schedule").value,
    scriptParams: tr.querySelector(".row-args").value,
    epicBotProfilePath: tr.querySelector(".row-epic-profile").value,
    world: Number(tr.querySelector(".row-world").value),
    worldMode: tr.querySelector(".row-world-mode").value,
    proxyId: tr.querySelector(".row-proxy").value,
    botClient: tr.querySelector(".row-launch-client")?.value || "dreambot",
    enabled: existingRow?.enabled !== false,
  };
}

async function deleteAccount(index) {
  await api("/api/account/delete", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
  toast("Conta excluída.");
  await loadState();
}

async function launchRow(tr) {
  const index = Number(tr.dataset.index);
  const launch = state.snapshot?.launches?.find((item) => item.index === index && isActiveLaunchStatus(item.status));
  if (launch) {
    toast("Essa conta já está rodando.");
    return;
  }

  await persistRow(tr);
  await api("/api/launch", {
    method: "POST",
    body: JSON.stringify({
      ...rowPayload(tr),
      botClient: tr.querySelector(".row-launch-client")?.value || "dreambot",
    }),
  });
  toast("Launch enviado.");
  await loadState();
}

async function checkAccount(index) {
  const result = await api("/api/checker/check", {
    method: "POST",
    body: JSON.stringify({ index }),
  });
  toast(result.message || "Checagem executada.");
  await loadState();
}

async function runAiAnalysis() {
  const button = $("#runAiAnalysisBtn");
  const previousText = button?.textContent || "Analisar agora";
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "Analisando...";
    }
    const scope = $("#aiAnalysisScope").value;
    const accountIndex = $("#aiAccountIndex").value;
    const result = await api("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({
        scope,
        index: scope === "account" && accountIndex !== "" ? Number(accountIndex) : undefined,
        prompt: $("#aiPrompt").value,
      }),
    });
    state.aiAnalysis = result;
    renderAiAnalysisResult(result);
    toast("Análise concluída.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

async function launchRowByIndex(index) {
  const tr = $(`#accountsBody tr[data-index="${index}"]`);
  if (tr) {
    await launchRow(tr);
    return;
  }

  const row = state.snapshot?.rows?.find((item) => Number(item.index) === Number(index));
  if (!row) throw new Error(`Conta ${index} não encontrada no painel.`);
  await api("/api/launch", {
    method: "POST",
    body: JSON.stringify({
      index: row.index,
      charName: row.charName,
      notes: row.notes,
      category: row.category,
      scriptName: row.scriptName,
      scheduleName: row.scheduleName,
      scriptParams: (row.scriptParams || []).join(" "),
      epicBotProfilePath: row.epicBotProfilePath || "",
      world: row.world,
      worldMode: row.worldMode,
      proxyId: row.proxyId,
      botClient: row.botClient || "dreambot",
      enabled: row.enabled,
    }),
  });
  toast(`Launch enviado para conta ${index}.`);
  await loadState();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function accountHasActiveLaunch(snapshot, index) {
  return (snapshot?.launches || []).some((launch) =>
    Number(launch.index) === Number(index) &&
    (launch.status === "Running" || launch.status === "Starting")
  );
}

function checkerResultIsFinal(snapshot, index) {
  const status = snapshot?.checker?.[index]?.status || "";
  return status === "ok" || status === "banned" || status === "error";
}

async function waitForCheckerAccountToClose(index, { timeoutMs = 2 * 60 * 1000, pollMs = 5000 } = {}) {
  const startedAt = Date.now();
  let sawActive = false;
  await writeCheckerLog("Aguardando conta anterior finalizar", { index, timeoutMs });

  while (Date.now() - startedAt < timeoutMs) {
    if (state.checkerBulkCancelRequested) return false;
    const snapshot = await api("/api/state");
    state.snapshot = snapshot;
    renderDashboard(snapshot);
    renderChecker(snapshot);
    switchTab("checkerPanel");

    const active = accountHasActiveLaunch(snapshot, index);
    const finalResult = checkerResultIsFinal(snapshot, index);
    if (active) sawActive = true;
    if (finalResult) {
      await writeCheckerLog("Resultado final detectado para a conta anterior", {
        index,
        active: active ? "sim" : "nao",
        waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
      if (active) {
        await writeCheckerLog("Conta anterior ainda ativa apos resultado final; solicitando stop sem cancelar fila", { index });
        await stopCheckerProcess(index, { keepQueueState: true, preserveQueue: true, quiet: true });
      }
      return true;
    }
    if (!active && sawActive) {
      await writeCheckerLog("Conta anterior finalizada", {
        index,
        waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
      return true;
    }

    await writeCheckerLog("Conta anterior ainda ativa", {
      index,
      waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
    await sleep(pollMs);
  }

  await writeCheckerLog("Timeout aguardando conta anterior finalizar", {
    index,
    waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
  return false;
}

async function waitForCheckerQueueDelay(position, total, delayMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    if (state.checkerBulkCancelRequested) return;
    const left = Math.ceil((delayMs - (Date.now() - startedAt)) / 1000);
    $("#checkSelectedAccountsBtn").textContent = `Próxima em ${left}s (${position}/${total})`;
    await sleep(Math.min(1000, delayMs - (Date.now() - startedAt)));
  }
}

function setQueueStatus({ label = "Fila de launch", text = "", progress = 0, hidden = false }) {
  const node = $("#queueStatus");
  if (state.queueStatusHideTimer) {
    window.clearTimeout(state.queueStatusHideTimer);
    state.queueStatusHideTimer = null;
  }
  node.hidden = hidden || !text;
  $("#queueStatusLabel").textContent = label;
  $("#queueStatusText").textContent = text;
  $("#queueProgressBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
}

function hideQueueStatus(delayMs = 0) {
  if (state.queueStatusHideTimer) window.clearTimeout(state.queueStatusHideTimer);
  state.queueStatusHideTimer = window.setTimeout(() => {
    $("#queueStatus").hidden = true;
    $("#queueStatusText").textContent = "";
    $("#queueProgressBar").style.width = "0%";
    state.queueStatusHideTimer = null;
  }, delayMs);
}

async function countdownLaunchDelay(seconds, remaining) {
  if (seconds <= 0) return;
  for (let left = seconds; left > 0; left -= 1) {
    setQueueStatus({
      text: `Aguardando ${left}s para o próximo launch · ${remaining} na fila`,
      progress: ((seconds - left) / seconds) * 100,
    });
    await sleep(1000);
  }
  setQueueStatus({
    text: `Preparando próximo launch · ${remaining} na fila`,
    progress: 100,
  });
}

function runningCount() {
  return state.snapshot?.launches?.filter((launch) => isActiveLaunchStatus(launch.status)).length || 0;
}

async function waitForLaunchSlot(limit) {
  while (runningCount() >= limit) {
    setQueueStatus({
      text: `Max instâncias atingido (${runningCount()}/${limit}) · aguardando vaga`,
      progress: 100,
    });
    await sleep(5000);
    await loadState();
  }
}

async function launchAll() {
  if (!state.snapshot || state.launchQueueRunning) return;
  state.launchQueueRunning = true;
  $("#launchAllBtn").disabled = true;

  try {
    const accountIndexes = new Set((state.snapshot.accounts || []).map((account) => Number(account.index)));
    const selectedIndexes = new Set(selectedAccountRows().map((tr) => Number(tr.dataset.index)));
    const visibleRows = getFilteredAccountRows(state.snapshot);
    const launchRows = selectedIndexes.size
      ? visibleRows.filter((row) => selectedIndexes.has(Number(row.index)) && accountIndexes.has(Number(row.index)))
      : visibleRows.filter((row) => row.enabled && accountIndexes.has(Number(row.index)));
    const launchLabel = selectedIndexes.size ? "selecionada(s)" : "habilitada(s) visível(is)";
    const limit = Math.max(1, Number(state.snapshot.config.maxInstances || 1));
    const delay = Math.max(0, Number(state.snapshot.config.launchDelaySeconds || 0));
    let launched = 0;
    if (!launchRows.length) {
      setQueueStatus({ text: selectedIndexes.size ? "Nenhuma conta selecionada visível para launch." : "Nenhuma conta habilitada visível para launch.", progress: 0 });
      hideQueueStatus(3500);
      return;
    }
    setQueueStatus({ text: `${launchRows.length} conta(s) ${launchLabel} na fila`, progress: 0 });

    for (let i = 0; i < launchRows.length; i += 1) {
      const remainingBefore = launchRows.length - i;
      setQueueStatus({
        text: `Lançando conta ${launchRows[i].index} · ${remainingBefore} na fila`,
        progress: (i / launchRows.length) * 100,
      });
      try {
        await waitForLaunchSlot(limit);
        await launchRowByIndex(launchRows[i].index);
        launched += 1;
      } catch (error) {
        toast(`Conta ${launchRows[i].index}: ${error.message}`);
      }
      if (i < launchRows.length - 1 && delay > 0) {
        await countdownLaunchDelay(delay, launchRows.length - i - 1);
        await loadState();
      }
    }
    setQueueStatus({
      text: `${launched}/${launchRows.length} conta(s) enviadas para launch.`,
      progress: 100,
    });
    toast(`${launched}/${launchRows.length} conta(s) enviadas para launch.`);
    hideQueueStatus(5000);
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

async function viewLaunchLog(pid) {
  const result = await api("/api/launch/log", {
    method: "POST",
    body: JSON.stringify({ pid }),
  });
  renderLaunchLog(result);
}

async function stopAll() {
  const result = await api("/api/stop-all", { method: "POST", body: JSON.stringify({}) });
  toast(`${result.stopped.length} processo(s) parado(s).`);
  await loadState();
}

async function shutdownAgent() {
  if (!window.confirm("Encerrar o agent local agora? O painel vai parar de responder até você abrir o .bat novamente.")) return;
  $("#shutdownAgentBtn").disabled = true;
  await api("/api/shutdown", { method: "POST", body: JSON.stringify({}) });
  $("#agentStatus").textContent = "Encerrando";
  $("#agentStatus").classList.remove("ok");
  toast("Agent encerrando. Abra o .bat para iniciar novamente.");
}

async function clearStoppedLaunches() {
  const result = await api("/api/launches/clear-stopped", { method: "POST", body: JSON.stringify({}) });
  toast(`${result.cleared} processo(s) parado(s) removido(s) do histórico.`);
  $("#launchLogViewer").hidden = true;
  await loadState();
}

async function clearLaunchHistory() {
  const result = await api("/api/launches/clear", { method: "POST", body: JSON.stringify({}) });
  toast(`${result.cleared} processo(s) removido(s) do histórico.`);
  $("#launchLogViewer").hidden = true;
  await loadState();
}

async function saveContinuousSettings(event) {
  event.preventDefault();
  await api("/api/continuous/settings", {
    method: "POST",
    body: JSON.stringify({
      enabled: $("#continuousEnabled").checked,
      checkIntervalSeconds: Number($("#continuousCheckInterval").value),
    }),
  });
  toast("Motor salvo.");
  await loadState();
}

async function startContinuous() {
  await api("/api/continuous/start", { method: "POST", body: JSON.stringify({}) });
  toast("Continuous iniciado.");
  await loadState();
}

async function stopContinuous() {
  await api("/api/continuous/stop", { method: "POST", body: JSON.stringify({}) });
  toast("Continuous pausado.");
  await loadState();
}

async function saveContinuousTask(event) {
  event.preventDefault();
  await api("/api/continuous/task", {
    method: "POST",
    body: JSON.stringify({
      id: $("#taskId").value,
      name: $("#taskName").value,
      category: $("#taskCategory").value,
      scriptName: $("#taskScriptName").value,
      scheduleName: $("#taskScheduleName").value,
      scriptParams: $("#taskScriptParams").value,
      epicBotProfilePath: $("#taskEpicBotProfilePath").value,
      world: Number($("#taskWorld").value),
      worldMode: $("#taskWorldMode").value,
      proxyMode: $("#taskProxyMode").value,
      proxyId: $("#taskProxyId").value,
      maxInstances: Number($("#taskMaxInstances").value),
      launchDelaySeconds: Number($("#taskLaunchDelaySeconds").value),
      cooldownMinutes: Number($("#taskCooldownMinutes").value),
      completionSkill: $("#taskCompletionSkill").value,
      completionLevel: Number($("#taskCompletionLevel").value),
      moveToCategoryOnComplete: $("#taskMoveToCategory").value,
      enabled: $("#taskEnabled").checked,
    }),
  });
  toast("Task salva.");
  resetTaskForm();
  await loadState();
}

function fillTaskForm(task) {
  $("#taskId").value = task.id || "";
  $("#taskName").value = task.name || "";
  $("#taskCategory").value = task.category || "default";
  $("#taskScriptName").value = task.scriptName || "";
  $("#taskScheduleName").value = task.scheduleName || "";
  $("#taskScriptParams").value = (task.scriptParams || []).join(" ");
  $("#taskEpicBotProfilePath").value = task.epicBotProfilePath || "";
  $("#taskWorld").value = task.world || state.snapshot?.config?.defaultWorld || 301;
  $("#taskWorldMode").value = task.worldMode || "fixed";
  $("#taskProxyMode").value = task.proxyMode || "account";
  $("#taskProxyId").value = task.proxyId || "";
  $("#taskMaxInstances").value = task.maxInstances || 1;
  $("#taskLaunchDelaySeconds").value = task.launchDelaySeconds || 0;
  $("#taskCooldownMinutes").value = task.cooldownMinutes || 0;
  $("#taskCompletionSkill").value = task.completionSkill || "";
  $("#taskCompletionLevel").value = task.completionLevel || "";
  $("#taskMoveToCategory").value = task.moveToCategoryOnComplete || "";
  $("#taskEnabled").checked = task.enabled !== false;
  syncTaskWorldAndProxyControls();
}

function resetTaskForm() {
  fillTaskForm({
    id: "",
    name: "",
    category: "default",
    scriptName: state.snapshot?.config?.defaultScriptName || "",
    scheduleName: "",
    scriptParams: [],
    epicBotProfilePath: "",
    world: state.snapshot?.config?.defaultWorld || 301,
    worldMode: "fixed",
    proxyMode: "account",
    proxyId: "",
    maxInstances: 1,
    launchDelaySeconds: state.snapshot?.config?.launchDelaySeconds || 0,
    cooldownMinutes: 30,
    completionSkill: "",
    completionLevel: "",
    moveToCategoryOnComplete: "",
    enabled: true,
  });
}

async function toggleTask(taskId) {
  const task = state.snapshot?.continuousTasks?.find((item) => item.id === taskId);
  if (!task) return;
  await api("/api/continuous/task/enabled", {
    method: "POST",
    body: JSON.stringify({ id: taskId, enabled: !task.enabled }),
  });
  toast(task.enabled ? "Task pausada." : "Task ativada.");
  await loadState();
}

async function deleteTask(taskId) {
  await api("/api/continuous/task/delete", {
    method: "POST",
    body: JSON.stringify({ id: taskId }),
  });
  toast("Task removida.");
  await loadState();
}

async function applyTask(taskId) {
  const task = state.snapshot?.continuousTasks?.find((item) => item.id === taskId);
  if (!task) return;
  const count = state.snapshot?.rows?.filter((row) => row.category === task.category).length || 0;
  if (!window.confirm(`Aplicar "${task.name}" em ${count} conta(s) da categoria "${task.category}"?`)) return;

  const result = await api("/api/continuous/task/apply", {
    method: "POST",
    body: JSON.stringify({ id: taskId }),
  });
  toast(`Task aplicada em ${result.updated} conta(s).`);
  await loadState();
}

async function toggleAllAccounts(checked) {
  const rows = $$("#accountsBody tr[data-index]");
  if (!rows.length) return;

  for (const tr of rows) {
    tr.querySelector(".row-selected").checked = checked;
    setAccountSelected(tr.dataset.index, checked);
  }
  syncSelectAllAccounts();
  toast(checked ? "Contas visíveis selecionadas." : "Seleção das contas visíveis removida.");
}

async function toggleAllCheckerAccounts(checked) {
  const rows = $$("#checkerBody tr[data-index]");
  if (!rows.length || state.checkerBulkRunning) return;

  for (const tr of rows) {
    tr.querySelector(".checker-row-selected").checked = checked;
    setCheckerSelected(tr.dataset.index, checked);
  }
  syncSelectAllCheckerAccounts();
  toast(checked ? "Contas visíveis do checker selecionadas." : "Seleção do checker removida.");
}

async function checkSelectedAccounts() {
  const indexes = [...state.selectedCheckerIndexes]
    .map((index) => Number(index))
    .filter((index) => Number.isInteger(index));
  if (!indexes.length || state.checkerBulkRunning) {
    toast("Nenhuma conta selecionada no checker.");
    return;
  }

  state.checkerBulkRunning = true;
  state.checkerBulkCancelRequested = false;
  syncSelectAllCheckerAccounts();
  $("#checkSelectedAccountsBtn").textContent = "Checando...";
  await writeCheckerLog("Fila do checker iniciada", { total: indexes.length, indexes: indexes.join(",") });

  try {
    let previousIndex = null;
    for (let position = 0; position < indexes.length; position += 1) {
      if (state.checkerBulkCancelRequested) break;
      if (previousIndex !== null) {
        $("#checkSelectedAccountsBtn").textContent = `Confirmando anterior ${position}/${indexes.length}`;
        const previousClosed = await waitForCheckerAccountToClose(previousIndex);
        if (!previousClosed) {
          toast(`Timeout aguardando a conta ${previousIndex} fechar. Encerrando processo.`);
          await writeCheckerLog("Timeout na conta anterior; solicitando stop", { index: previousIndex });
          await stopCheckerProcess(previousIndex, { keepQueueState: true, preserveQueue: true, quiet: true });
        }
        await refreshStatePreservingTab("checkerPanel");
        if (state.checkerBulkCancelRequested) break;
      }

      const index = indexes[position];
      state.currentCheckerIndex = index;
      toast(`Checando ${position + 1} de ${indexes.length}...`);
      $("#checkSelectedAccountsBtn").textContent = `Checando ${position + 1}/${indexes.length}`;
      await writeCheckerLog("Iniciando checagem da conta", { index, position: position + 1, total: indexes.length });
      const result = await api("/api/checker/check", {
        method: "POST",
        body: JSON.stringify({ index }),
      });
      await writeCheckerLog("Resposta inicial do checker", { index, status: result.status, message: result.message || "" });
      if (result.status !== "capturing") {
        await sleep(800);
      }
      await refreshStatePreservingTab("checkerPanel");
      previousIndex = index;
    }
    if (previousIndex !== null) {
      state.currentCheckerIndex = previousIndex;
      $("#checkSelectedAccountsBtn").textContent = `Finalizando ${indexes.length}/${indexes.length}`;
      await waitForCheckerAccountToClose(previousIndex);
      await refreshStatePreservingTab("checkerPanel");
    }
    await writeCheckerLog(state.checkerBulkCancelRequested ? "Fila do checker encerrada manualmente" : "Fila do checker finalizada", { total: indexes.length });
    toast(state.checkerBulkCancelRequested ? "Checker encerrado." : `Checker finalizado para ${indexes.length} conta(s).`);
    await refreshStatePreservingTab("checkerPanel");
  } finally {
    state.checkerBulkRunning = false;
    state.checkerBulkCancelRequested = false;
    state.currentCheckerIndex = null;
    $("#checkSelectedAccountsBtn").textContent = "Checar selecionadas";
    syncSelectAllCheckerAccounts();
  }
}

async function stopCheckerProcess(index = state.currentCheckerIndex, options = {}) {
  if (!options.preserveQueue) {
    state.checkerBulkCancelRequested = true;
  }
  const parsed = Number(index);
  await writeCheckerLog("Stop do checker solicitado pelo painel", { index: Number.isInteger(parsed) ? parsed : "todos" });
  await api("/api/checker/stop", {
    method: "POST",
    body: JSON.stringify({ index: Number.isInteger(parsed) ? parsed : null }),
  });
  if (!options.keepQueueState) {
    state.checkerBulkRunning = false;
    state.currentCheckerIndex = null;
    $("#checkSelectedAccountsBtn").textContent = "Checar selecionadas";
  }
  if (!options.quiet) toast("Checker encerrado.");
  await refreshStatePreservingTab("checkerPanel");
  syncSelectAllCheckerAccounts();
}

async function applyBulkAccountFields() {
  const rows = selectedAccountRows();
  if (!rows.length) {
    toast("Nenhuma conta selecionada.");
    return;
  }

  const scriptName = $("#bulkScriptName").value.trim();
  const scriptParams = $("#bulkScriptParams").value.trim();
  const epicBotProfilePath = $("#bulkEpicBotProfilePath").value.trim();
  const category = $("#bulkCategory").value;
  const worldMode = $("#bulkWorldMode").value;
  const world = Number($("#bulkWorld").value || 301);

  if (!category && !scriptName && !scriptParams && !epicBotProfilePath && worldMode === "fixed" && !$("#bulkWorld").value.trim()) {
    toast("Preencha pelo menos um campo para aplicar.");
    return;
  }

  $("#applyBulkAccountsBtn").disabled = true;
  try {
    for (const tr of rows) {
      if (category) tr.querySelector(".row-category").value = category;
      if (scriptName) tr.querySelector(".row-script").value = scriptName;
      if (scriptParams) tr.querySelector(".row-args").value = scriptParams;
      if (epicBotProfilePath) tr.querySelector(".row-epic-profile").value = epicBotProfilePath;
      tr.querySelector(".row-world-mode").value = worldMode;
      tr.querySelector(".row-world").value = Number.isFinite(world) && world > 0 ? world : 301;
      tr.querySelector(".row-world").disabled = worldMode !== "fixed";
      await persistRow(tr);
    }
    toast(`Campos aplicados em ${rows.length} conta(s).`);
    await loadState();
  } finally {
    $("#applyBulkAccountsBtn").disabled = false;
  }
}

async function deleteSelectedAccounts() {
  const rows = selectedAccountRows();
  if (!rows.length) {
    toast("Nenhuma conta selecionada.");
    return;
  }

  const indexes = rows
    .map((tr) => Number(tr.dataset.index))
    .sort((a, b) => b - a);
  const runningIndexes = new Set((state.snapshot?.launches || [])
    .filter((launch) => isActiveLaunchStatus(launch.status))
    .map((launch) => Number(launch.index)));
  const runningSelected = indexes.filter((index) => runningIndexes.has(index));
  if (runningSelected.length) {
    toast(`Pare primeiro ${runningSelected.length} conta(s) online selecionada(s).`);
    return;
  }

  if (!window.confirm(`Excluir ${indexes.length} conta(s) selecionada(s)? Essa ação remove as contas do accounts.txt e do farm.json.`)) return;

  $("#deleteBulkAccountsBtn").disabled = true;
  try {
    for (const index of indexes) {
      await api("/api/account/delete", {
        method: "POST",
        body: JSON.stringify({ index }),
      });
    }
    toast(`${indexes.length} conta(s) excluída(s).`);
    await loadState();
  } finally {
    $("#deleteBulkAccountsBtn").disabled = false;
  }
}

function syncTaskWorldAndProxyControls() {
  $("#taskWorld").disabled = $("#taskWorldMode").value !== "fixed";
  $("#taskProxyId").disabled = $("#taskProxyMode").value !== "task";
}

document.addEventListener("click", async (event) => {
  const deleteAccountButton = event.target.closest(".delete-account");
  const launchButton = event.target.closest(".launch-row");
  const refreshSummaryStatsButton = event.target.closest(".refresh-summary-stats");
  const stopButton = event.target.closest(".stop-process");
  const viewLaunchLogButton = event.target.closest(".view-launch-log");
  const closeLaunchLogButton = event.target.closest(".close-launch-log");
  const deleteProxyButton = event.target.closest(".delete-proxy");
  const deleteCategoryButton = event.target.closest(".delete-category");
  const editTaskButton = event.target.closest(".edit-task");
  const applyTaskButton = event.target.closest(".apply-task");
  const toggleTaskButton = event.target.closest(".toggle-task");
  const deleteTaskButton = event.target.closest(".delete-task");
  const checkAccountButton = event.target.closest(".check-account");

  try {
    if (deleteAccountButton) {
      await deleteAccount(Number(deleteAccountButton.closest("tr").dataset.index));
    }
    if (launchButton) {
      await launchRow(launchButton.closest("tr"));
    }
    if (refreshSummaryStatsButton) {
      const row = refreshSummaryStatsButton.closest("tr")
        || $(`#accountsBody tr[data-index="${refreshSummaryStatsButton.dataset.index}"]`)
        || $(`#checkerBody tr[data-index="${refreshSummaryStatsButton.dataset.index}"]`);
      if (row) await loadSummaryStats(row, true);
    }
    if (viewLaunchLogButton) {
      await viewLaunchLog(Number(viewLaunchLogButton.dataset.pid));
    }
    if (closeLaunchLogButton) {
      $("#launchLogViewer").hidden = true;
    }
    if (stopButton) {
      await stopProcess(Number(stopButton.dataset.pid));
    }
    if (deleteProxyButton) {
      await deleteProxy(deleteProxyButton.dataset.proxyId);
    }
    if (deleteCategoryButton) {
      await deleteCategory(deleteCategoryButton.dataset.category);
    }
    if (editTaskButton) {
      const taskId = editTaskButton.closest("tr").dataset.taskId;
      const task = state.snapshot?.continuousTasks?.find((item) => item.id === taskId);
      if (task) fillTaskForm(task);
    }
    if (applyTaskButton) {
      await applyTask(applyTaskButton.closest("tr").dataset.taskId);
    }
    if (toggleTaskButton) {
      await toggleTask(toggleTaskButton.closest("tr").dataset.taskId);
    }
    if (deleteTaskButton) {
      await deleteTask(deleteTaskButton.closest("tr").dataset.taskId);
    }
    if (checkAccountButton) {
      await checkAccount(Number(checkAccountButton.closest("tr").dataset.index));
    }
    if (event.target.closest("#checkSelectedAccountsBtn")) {
      await checkSelectedAccounts();
    }
    if (event.target.closest("#stopCheckerQueueBtn")) {
      await stopCheckerProcess();
    }
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener("mouseover", (event) => {
  const wrap = event.target.closest(".summary-wrap");
  if (!wrap) return;
  positionSummaryPopover(wrap);
  const tr = wrap.closest("tr");
  if (tr) {
    loadSummaryStats(tr)
      .then(() => positionSummaryPopover(wrap))
      .catch((error) => toast(error.message));
  }
});

document.addEventListener("mouseout", (event) => {
  const wrap = event.target.closest(".summary-wrap");
  if (wrap && !wrap.contains(event.relatedTarget)) clearSummaryPopoverPosition(wrap);
});

document.addEventListener("change", (event) => {
  if (event.target.closest("#bulkWorldMode")) {
    $("#bulkWorld").disabled = $("#bulkWorldMode").value !== "fixed";
    return;
  }

  if (event.target.closest("#selectAllAccounts")) {
    toggleAllAccounts(event.target.checked).catch((error) => toast(error.message));
    return;
  }

  if (event.target.closest("#selectAllCheckerAccounts")) {
    toggleAllCheckerAccounts(event.target.checked).catch((error) => toast(error.message));
    return;
  }

  const checkerSelectedCheckbox = event.target.closest(".checker-row-selected");
  if (checkerSelectedCheckbox) {
    const tr = checkerSelectedCheckbox.closest("tr");
    setCheckerSelected(tr?.dataset.index, checkerSelectedCheckbox.checked);
    syncSelectAllCheckerAccounts();
    return;
  }

  const selectedCheckbox = event.target.closest(".row-selected");
  if (selectedCheckbox) {
    const tr = selectedCheckbox.closest("tr");
    setAccountSelected(tr?.dataset.index, selectedCheckbox.checked);
    syncSelectAllAccounts();
    return;
  }

  const worldMode = event.target.closest(".row-world-mode");
  if (worldMode) {
    const input = worldMode.closest(".world-control").querySelector(".row-world");
    input.disabled = worldMode.value !== "fixed";
  }

  const changedRowControl = event.target.closest("#accountsBody input, #accountsBody select");
  if (changedRowControl) {
    const tr = changedRowControl.closest("tr");
    persistRow(tr).catch((error) => toast(error.message));
  }

  if (event.target.closest("#taskWorldMode, #taskProxyMode")) {
    syncTaskWorldAndProxyControls();
  }
});

document.addEventListener("focusin", (event) => {
  if (event.target.closest("#accountsBody input, #accountsBody select")) {
    state.isEditingAccountRow = true;
  }
});

document.addEventListener("focusout", (event) => {
  const editedRowControl = event.target.closest("#accountsBody input, #accountsBody select");
  if (!editedRowControl) return;
  const tr = editedRowControl.closest("tr");

  window.setTimeout(() => {
    const stillEditingAccounts = Boolean(document.activeElement?.closest("#accountsBody input, #accountsBody select"));
    state.isEditingAccountRow = stillEditingAccounts;
    if (!stillEditingAccounts) {
      persistRow(tr).catch((error) => toast(error.message));
    }
  }, 0);
});

$("#settingsForm").addEventListener("submit", (event) => saveSettings(event).catch((error) => toast(error.message)));
$("#accountForm").addEventListener("submit", (event) => addAccount(event).catch((error) => toast(error.message)));
$("#bulkImportForm").addEventListener("submit", (event) => bulkImport(event).catch((error) => toast(error.message)));
$("#categoryForm").addEventListener("submit", (event) => addCategory(event).catch((error) => toast(error.message)));
$("#proxyForm").addEventListener("submit", (event) => addProxy(event).catch((error) => toast(error.message)));
$("#bulkProxyForm").addEventListener("submit", (event) => bulkImportProxies(event).catch((error) => toast(error.message)));
$("#continuousSettingsForm").addEventListener("submit", (event) => saveContinuousSettings(event).catch((error) => toast(error.message)));
$("#continuousTaskForm").addEventListener("submit", (event) => saveContinuousTask(event).catch((error) => toast(error.message)));
$("#refreshBtn").addEventListener("click", () => loadState().catch((error) => toast(error.message)));
$("#exportAccountsBtn").addEventListener("click", () => exportAccounts().catch((error) => toast(error.message)));
document.addEventListener("click", (event) => {
  if (event.target.closest("#refreshDiagnosticsBtn")) {
    loadState().catch((error) => toast(error.message));
  }
  if (event.target.closest("#refreshPerformanceBtn")) {
    loadState().catch((error) => toast(error.message));
  }
});
$("#launchAllBtn").addEventListener("click", () => launchAll().catch((error) => toast(error.message)));
$("#applyBulkAccountsBtn").addEventListener("click", () => applyBulkAccountFields().catch((error) => toast(error.message)));
$("#deleteBulkAccountsBtn").addEventListener("click", () => deleteSelectedAccounts().catch((error) => toast(error.message)));
$("#continuousStartBtn").addEventListener("click", () => startContinuous().catch((error) => toast(error.message)));
$("#continuousStopBtn").addEventListener("click", () => stopContinuous().catch((error) => toast(error.message)));
$("#stopAllBtn").addEventListener("click", () => stopAll().catch((error) => toast(error.message)));
$("#shutdownAgentBtn").addEventListener("click", () => shutdownAgent().catch((error) => toast(error.message)));
window.addEventListener("scroll", clearAllSummaryPopovers, true);
window.addEventListener("resize", clearAllSummaryPopovers);
$("#activeLaunchesOnlyBtn").addEventListener("click", () => {
  state.showAllLaunches = false;
  renderLaunches(state.snapshot?.launches || []);
});
$("#showAllLaunchesBtn").addEventListener("click", () => {
  state.showAllLaunches = true;
  renderLaunches(state.snapshot?.launches || []);
});
$("#clearStoppedLaunchesBtn").addEventListener("click", () => clearStoppedLaunches().catch((error) => toast(error.message)));
$("#clearLaunchHistoryBtn").addEventListener("click", () => clearLaunchHistory().catch((error) => toast(error.message)));
$("#resetTaskFormBtn").addEventListener("click", resetTaskForm);
$("#accountSearch").addEventListener("input", (event) => {
  state.accountFilters.search = event.target.value.trim();
  if (!state.snapshot) return;
  clearAccountSelection();
  renderDashboard(state.snapshot);
  renderAccounts(state.snapshot);
});
for (const id of ["accountFilterCategory", "accountFilterStatus", "accountFilterEnabled", "accountFilterNick", "accountFilterChecker"]) {
  $(`#${id}`).addEventListener("change", (event) => {
    const key = id.replace("accountFilter", "").toLowerCase();
    state.accountFilters[key] = event.target.value;
    if (!state.snapshot) return;
    clearAccountSelection();
    renderDashboard(state.snapshot);
    renderAccounts(state.snapshot);
  });
}
$("#clearAccountFiltersBtn").addEventListener("click", () => {
  state.accountFilters = { search: "", category: "", status: "", enabled: "", nick: "", checker: "" };
  if (!state.snapshot) return;
  clearAccountSelection();
  renderDashboard(state.snapshot);
  renderAccounts(state.snapshot);
});

$("#checkerSearch").addEventListener("input", (event) => {
  state.checkerFilters.search = event.target.value.trim();
  if (!state.snapshot) return;
  renderChecker(state.snapshot);
});
for (const id of ["checkerFilterCategory", "checkerFilterStatus", "checkerFilterEnabled", "checkerFilterNick", "checkerFilterResult"]) {
  $(`#${id}`).addEventListener("change", (event) => {
    const key = id.replace("checkerFilter", "").toLowerCase();
    state.checkerFilters[key] = event.target.value;
    if (!state.snapshot) return;
    renderChecker(state.snapshot);
  });
}
$("#clearCheckerFiltersBtn").addEventListener("click", () => {
  state.checkerFilters = { search: "", category: "", status: "", enabled: "", nick: "", result: "" };
  if (!state.snapshot) return;
  renderChecker(state.snapshot);
});
$("#refreshCheckerLogBtn").addEventListener("click", () => loadCheckerLog().catch((error) => toast(error.message)));
$("#clearCheckerLogBtn").addEventListener("click", () => clearCheckerLog().catch((error) => toast(error.message)));
$("#runAiAnalysisBtn").addEventListener("click", () => runAiAnalysis().catch((error) => toast(error.message)));
$("#clearAiAnalysisBtn").addEventListener("click", () => {
  state.aiAnalysis = null;
  renderAiAnalysisResult(null);
});
$("#aiAnalysisScope").addEventListener("change", () => renderAiControls(state.snapshot || {}));

for (const button of $$(".tab-button")) {
  button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
}

loadState().catch((error) => {
  $("#agentStatus").textContent = "Erro";
  toast(error.message);
});

window.setInterval(() => {
  if (document.hidden) return;
  if (state.checkerBulkRunning) return;
  loadState().catch(() => {});
}, 15000);
