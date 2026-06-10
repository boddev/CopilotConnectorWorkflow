(function () {
  const $ = (sel) => document.querySelector(sel);
  const jobsEl = $('#jobs');
  const detailEl = $('#detail');
  const logEl = $('#log');
  const form = $('#job-form');
  const modeSelect = $('#mode-select');
  const authFields = $('#auth-fields');
  let activeJobId = null;
  let logSrc = null;

  modeSelect.addEventListener('change', () => {
    const provision = modeSelect.value === 'provision';
    authFields.hidden = !provision;
    document.getElementById('score-fields').hidden = !provision;
    const hint = document.getElementById('build-mode-hint');
    if (hint) hint.hidden = provision;
    authFields.querySelectorAll('input').forEach((el) => {
      if (el.type !== 'checkbox') el.required = provision && ['tenantId','clientId'].includes(el.name);
    });
  });

  // ----- Slice 4: judge provider toggle -----
  const judgeProviderSelect = document.getElementById('judge-provider-select');
  const judgeAgentRow = document.getElementById('judge-agent-row');
  judgeProviderSelect.addEventListener('change', () => {
    const isWorkiq = judgeProviderSelect.value === 'workiq';
    judgeAgentRow.hidden = !isWorkiq;
    const judgeAgentInput = form.querySelector('[name=judgeAgentId]');
    if (judgeAgentInput) judgeAgentInput.required = isWorkiq;
  });

  // ----- Slice 6: Validate auth button -----
  const validateAuthBtn = document.getElementById('validate-auth-btn');
  if (validateAuthBtn) {
    validateAuthBtn.addEventListener('click', async () => {
      const out = document.getElementById('validate-auth-result');
      out.textContent = 'Running...';
      try {
        const tenantId = form.querySelector('[name=tenantId]')?.value || '';
        const clientId = form.querySelector('[name=clientId]')?.value || '';
        const clientSecretEnvVar = form.querySelector('[name=clientSecretEnvVar]')?.value || '';
        const clientSecret = form.querySelector('[name=clientSecret]')?.value || '';
        const useManagedIdentity = form.querySelector('[name=useManagedIdentity]')?.checked || false;
        const skipWorkiq = form.querySelector('[name=skipWorkiqAuth]')?.checked || false;
        const r = await fetch('/api/auth-preflight', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            clientId,
            clientSecretEnvVar,
            clientSecret: clientSecret || undefined,
            useManagedIdentity,
            runGraph: true,
            runWorkIq: !skipWorkiq,
          }),
        });
        const body = await r.json().catch(() => ({}));
        out.textContent = JSON.stringify(body, null, 2);
      } catch (e) {
        out.textContent = 'Error: ' + (e.message || e);
      }
    });
  }

  // ----- Browse for a dataset folder (native OS picker via the local server) -----
  const browseDatasetBtn = document.getElementById('browse-dataset-btn');
  if (browseDatasetBtn) {
    browseDatasetBtn.addEventListener('click', async () => {
      const datasetInput = form.querySelector('[name=dataset]');
      const prevLabel = browseDatasetBtn.textContent;
      browseDatasetBtn.disabled = true;
      browseDatasetBtn.textContent = 'Opening…';
      try {
        const r = await fetch('/api/browse-folder', { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { alert('Could not open folder picker: ' + (body.error || r.status)); return; }
        if (body.path) {
          datasetInput.value = body.path;
          datasetInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (e) {
        alert('Could not open folder picker: ' + (e.message || e));
      } finally {
        browseDatasetBtn.disabled = false;
        browseDatasetBtn.textContent = prevLabel;
      }
    });
  }

  // ----- Slice 3: eval-source picker -----
  const evalSourceSelect = document.getElementById('eval-source-select');
  const evalReuseJobBlock = document.getElementById('eval-source-reuse-job');
  const evalReusePathBlock = document.getElementById('eval-source-reuse-path');
  const reuseEvalSelect = document.getElementById('reuse-eval-select');
  const reuseEvalPaste = document.getElementById('reuse-eval-paste');
  const reuseEvalPasteHint = document.getElementById('reuse-eval-paste-hint');

  evalSourceSelect.addEventListener('change', () => {
    evalReuseJobBlock.hidden = evalSourceSelect.value !== 'reuseFromJob';
    evalReusePathBlock.hidden = evalSourceSelect.value !== 'reuseFromPath';
  });

  /** Fetch scored provision-mode jobs and populate the reuse-eval dropdown. */
  async function listScoredJobs() {
    try {
      const r = await fetch('/api/jobs?scored=true&provisionOnly=false&limit=200');
      if (!r.ok) return [];
      return await r.json();
    } catch {
      return [];
    }
  }
  async function refreshReuseEvalDropdown() {
    const jobs = await listScoredJobs();
    const currentVal = reuseEvalSelect.value;
    reuseEvalSelect.innerHTML = '<option value="">— select a job —</option>' + jobs.map((j) => {
      const noEnh = j.config?.noEnhance ? ' [no-enhance]' : '';
      const label = `${j.id} — ${j.config?.connectorName || j.config?.connectorId || '?'}${noEnh}`;
      return `<option value="${escapeHtml(j.id)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (currentVal) reuseEvalSelect.value = currentVal;
  }
  reuseEvalPaste.addEventListener('blur', async () => {
    const id = reuseEvalPaste.value.trim();
    if (!id) { reuseEvalPasteHint.textContent = ''; reuseEvalPasteHint.className = 'hint'; return; }
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
      if (r.status === 404) {
        reuseEvalPasteHint.textContent = `Job ${id} not found.`;
        reuseEvalPasteHint.className = 'hint bad';
        return;
      }
      if (!r.ok) {
        reuseEvalPasteHint.textContent = `Could not load job ${id} (HTTP ${r.status}).`;
        reuseEvalPasteHint.className = 'hint bad';
        return;
      }
      const job = await r.json();
      const noEnh = job.config?.noEnhance ? 'yes' : 'no';
      const scoreStatus = job.steps?.score?.status || '?';
      const hash = job.evalSetHash || '(no eval-set hash yet)';
      reuseEvalPasteHint.textContent = `Found: noEnhance=${noEnh}, mode=${job.config?.mode}, score=${scoreStatus}, evalSetHash=${hash}`;
      reuseEvalPasteHint.className = 'hint';
    } catch (e) {
      reuseEvalPasteHint.textContent = `Error: ${e.message || e}`;
      reuseEvalPasteHint.className = 'hint bad';
    }
  });

  async function refreshTools() {
    const r = await fetch('/api/tools').then((x) => x.json());
    const html = r.map((t) => `<span class="${t.ok ? 'ok' : 'bad'}">${t.ok ? '✓' : '✗'} ${t.name}</span>`).join(' &nbsp; ');
    $('#tools-status').innerHTML = html;
  }

  async function refreshJobs() {
    const jobs = await fetch('/api/jobs').then((x) => x.json());
    jobsEl.innerHTML = '';
    for (const j of jobs) {
      const li = document.createElement('li');
      const noEnh = j.config?.noEnhance ? '<span class="badge no-enhance">no-enhance</span>' : '';
      const judge = j.config?.score?.judgeProvider ? `<span class="badge">judge:${escapeHtml(j.config.score.judgeProvider)}</span>` : '';
      const legacy = j.steps && 'm365eval' in j.steps && !('score' in j.steps) ? '<span class="badge legacy">legacy</span>' : '';
      const connector = j.config?.connectorId ? `<span class="badge">${escapeHtml(j.config.connectorId)}</span>` : '';
      li.innerHTML = `${escapeHtml(j.id)} — ${escapeHtml(j.status)} ${connector}${noEnh}${judge}${legacy}`;
      if (j.id === activeJobId) li.classList.add('active');
      li.addEventListener('click', () => selectJob(j.id));
      jobsEl.appendChild(li);
    }
  }

  async function selectJob(id) {
    activeJobId = id;
    await refreshJobs();
    const job = await fetch(`/api/jobs/${id}`).then((x) => x.json());
    renderDetail(job);
    subscribeLogs(id);
  }

  function renderDetail(job) {
    const stepOrder = ['evalgen','enhance','schema','connector','deploy','score'];
    const rows = stepOrder.map((n) => {
      const s = job.steps[n] || { status: 'pending' };
      return `<div class="step-row"><span>${n}</span><span class="status status-${s.status}">${s.status}${s.errorMessage ? ' — ' + escapeHtml(s.errorMessage) : ''}</span></div>`;
    }).join('');
    const artifacts = collectArtifacts(job);
    const artLinks = artifacts.map((p) => `<a class="artifact-link" href="/api/jobs/${job.id}/file?path=${encodeURIComponent(p)}" target="_blank">${escapeHtml(p)}</a>`).join('');
    const resumeBtn = `<button id="resume-btn">Resume / re-run</button>
      <label style="display:inline-block;margin-left:8px;font-size:0.8rem;"><input type="checkbox" id="force-check"> force all</label>
      <label style="display:block;margin-top:4px;font-size:0.8rem;">start at <input type="text" id="resume-start-at" list="step-names" style="width:9em;"></label>
      <label style="display:block;font-size:0.8rem;">stop after <input type="text" id="resume-stop-after" list="step-names" style="width:9em;"></label>
      <label style="display:block;font-size:0.8rem;">force steps (csv) <input type="text" id="resume-force-steps" list="step-names" style="width:18em;"></label>`;
    detailEl.innerHTML = `
      <div><strong>${job.id}</strong> — ${job.status}</div>
      <div style="margin-top:6px;font-size:0.8rem;color:#666;">${escapeHtml(job.config.connectorName)} (${escapeHtml(job.config.connectorId)})</div>
      <div style="margin:8px 0;">${rows}</div>
      <div>${resumeBtn}</div>
      <h4 style="margin:12px 0 4px;font-size:0.9rem;">Artifacts</h4>
      <div>${artLinks || '<em style="font-size:0.8rem;">none yet</em>'}</div>
    `;
    $('#resume-btn').addEventListener('click', async () => {
      const forceAll = $('#force-check').checked;
      const startAt = ($('#resume-start-at').value || '').trim() || undefined;
      const stopAfter = ($('#resume-stop-after').value || '').trim() || undefined;
      const forceStepsRaw = ($('#resume-force-steps').value || '').trim();
      const forceSteps = forceStepsRaw ? forceStepsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      await fetch(`/api/jobs/${job.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll, startAt, stopAfter, forceSteps }),
      });
      setTimeout(() => selectJob(job.id), 500);
    });
  }

  function collectArtifacts(job) {
    const out = [];
    for (const s of Object.values(job.steps)) {
      for (const k of Object.keys(s.outputs || {})) out.push(k);
    }
    return out;
  }

  function subscribeLogs(id) {
    if (logSrc) { logSrc.close(); logSrc = null; }
    logEl.textContent = '';
    logSrc = new EventSource(`/api/jobs/${id}/logs`);
    logSrc.onmessage = (e) => {
      try {
        const obj = JSON.parse(e.data);
        const prefix = obj.label ? `[${obj.label}] ` : '';
        logEl.textContent += prefix + obj.text;
        logEl.scrollTop = logEl.scrollHeight;
      } catch {}
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    const payload = {
      dataset: data.dataset,
      description: data.description,
      count: Number(data.count || 30),
      extensions: data.extensions ? data.extensions.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      connectorId: data.connectorId,
      connectorName: data.connectorName,
      connectorDescription: data.connectorDescription || undefined,
      deployTarget: data.deployTarget,
      mode: data.mode,
      aclMode: data.aclMode,
    };
    if (form.querySelector('[name=noEnhance]')?.checked) payload.noEnhance = true;

    // Slice 5: remaining ccw run flags.
    const agentName = (data.agentName || '').trim();
    if (agentName) payload.agentName = agentName;
    const agentInstructions = (data.agentInstructions || '').trim();
    if (agentInstructions) payload.agentInstructions = agentInstructions;
    const urlPrefix = (data.urlPrefix || '').trim();
    if (urlPrefix) payload.urlPrefix = urlPrefix;

    // Slice 3: eval-source -> reuseEvalFromJobId XOR evalSetPath (mirror CLI guard).
    const evalSource = data.evalSource || 'generate';
    if (evalSource === 'reuseFromJob') {
      const picked = (data.reuseEvalFromJobId || '').trim();
      const pasted = (data.reuseEvalFromJobIdPasted || '').trim();
      const reuseId = picked || pasted;
      if (!reuseId) { alert('Select a source job from the dropdown or paste a job id'); return; }
      payload.reuseEvalFromJobId = reuseId;
    } else if (evalSource === 'reuseFromPath') {
      const p = (data.evalSetPath || '').trim();
      if (!p) { alert('Enter the eval set folder path'); return; }
      payload.evalSetPath = p;
    }

    if (payload.mode === 'provision') {
      payload.auth = {
        tenantId: data.tenantId,
        clientId: data.clientId,
        clientSecretEnvVar: data.clientSecretEnvVar || undefined,
        useManagedIdentity: form.querySelector('[name=useManagedIdentity]').checked,
      };
      // Slice 4: build payload.score with mirror-CLI validation.
      const judgeProvider = (data.judgeProvider || 'github-copilot').trim();
      const judgeAgentId = (data.judgeAgentId || '').trim();
      const candidateAgentId = (data.candidateAgentId || '').trim();
      if (judgeProvider === 'workiq' && !judgeAgentId) {
        alert("Judge agent id is required when judge provider is 'workiq'");
        return;
      }
      payload.score = {
        judgeProvider,
        judgeAgentId: judgeAgentId || undefined,
        candidateAgentId: candidateAgentId || undefined,
      };
      if (!candidateAgentId) {
        const proceed = window.confirm(
          'Candidate agent id is empty.\n\n' +
          'Step 6 will look for the agent id in 05-deploy/resources.json. If Step 5 cannot ' +
          'discover or publish an agent for this connector, Step 6 will fail.\n\n' +
          'Proceed anyway?'
        );
        if (!proceed) return;
      }
    }

    // Slice 6: runtime overrides for start/stop/force/preflight.
    const runtime = {};
    const startAt = (data.startAt || '').trim();
    if (startAt) runtime.startAt = startAt;
    const stopAfter = (data.stopAfter || '').trim();
    if (stopAfter) runtime.stopAfter = stopAfter;
    const forceStepsRaw = (data.forceSteps || '').trim();
    if (forceStepsRaw) runtime.forceSteps = forceStepsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (form.querySelector('[name=forceAllNew]')?.checked) runtime.forceAll = true;
    const wantsAuthPreflight = !!form.querySelector('[name=authPreflight]')?.checked;
    const skipWorkiqAuth = !!form.querySelector('[name=skipWorkiqAuth]')?.checked;

    if (wantsAuthPreflight) {
      const pre = await fetch('/api/auth-preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: payload.auth?.tenantId,
          clientId: payload.auth?.clientId,
          clientSecretEnvVar: payload.auth?.clientSecretEnvVar,
          clientSecret: (data.clientSecret || '').trim() || undefined,
          useManagedIdentity: payload.auth?.useManagedIdentity,
          runGraph: payload.mode === 'provision',
          runWorkIq: !skipWorkiqAuth,
        }),
      });
      const preBody = await pre.json().catch(() => ({}));
      if (!preBody.passed) {
        alert('Auth preflight failed. See the Validate auth result for details.');
        const out = document.getElementById('validate-auth-result');
        if (out) out.textContent = JSON.stringify(preBody, null, 2);
        return;
      }
    }

    const r = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: payload, runtime, secret: (data.clientSecret || '').trim() || undefined }),
    });
    if (!r.ok) { const err = await r.json().catch(() => ({})); alert('Failed: ' + (err.error || r.status)); return; }
    const job = await r.json();
    activeJobId = job.id;
    await refreshJobs();
    await selectJob(job.id);
  });

  // ----- Slice 7: Compare panel -----
  const compareJobA = document.getElementById('compare-job-a');
  const compareJobB = document.getElementById('compare-job-b');
  const compareBtn = document.getElementById('compare-btn');
  const compareSummary = document.getElementById('compare-summary');
  const compareReportPre = document.getElementById('compare-report');
  const compareCsvLink = document.getElementById('compare-csv-link');
  let compareScoredJobs = [];  // cached list for cascading second dropdown

  async function refreshCompareDropdowns() {
    try {
      const r = await fetch('/api/jobs?scored=true&provisionOnly=true&limit=200');
      compareScoredJobs = r.ok ? await r.json() : [];
    } catch {
      compareScoredJobs = [];
    }
    fillCompareDropdown(compareJobA, compareScoredJobs);
    fillCompareDropdown(compareJobB, compareScoredJobs);
    applyCompareCascade();
  }

  function fillCompareDropdown(selectEl, jobs, options = {}) {
    const currentVal = selectEl.value;
    const opts = jobs.map((j) => {
      const noEnh = j.config?.noEnhance ? ' [no-enhance]' : '';
      const judge = j.config?.score?.judgeProvider ? ` [judge:${j.config.score.judgeProvider}]` : '';
      const label = `${j.id} — ${j.config?.connectorName || j.config?.connectorId || '?'}${noEnh}${judge}`;
      const reason = options.reasonFor ? options.reasonFor(j) : '';
      const disabled = reason ? ' disabled' : '';
      const suffix = reason ? ` — ${reason}` : '';
      return `<option value="${escapeHtml(j.id)}"${disabled} title="${escapeHtml(reason)}">${escapeHtml(label + suffix)}</option>`;
    }).join('');
    selectEl.innerHTML = '<option value="">— select —</option>' + opts;
    if (currentVal) selectEl.value = currentVal;
  }

  function applyCompareCascade() {
    const aId = compareJobA.value;
    if (!aId) {
      fillCompareDropdown(compareJobB, compareScoredJobs);
      return;
    }
    const a = compareScoredJobs.find((j) => j.id === aId);
    if (!a) return;
    fillCompareDropdown(compareJobB, compareScoredJobs, {
      reasonFor: (b) => {
        if (b.id === a.id) return 'same as Job A';
        if (!!a.config?.noEnhance === !!b.config?.noEnhance) return 'same noEnhance value';
        if (a.datasetHash && b.datasetHash && a.datasetHash !== b.datasetHash) return 'different datasetHash';
        if (a.evalSetHash && b.evalSetHash && a.evalSetHash !== b.evalSetHash) return 'different evalSetHash';
        return '';
      },
    });
  }

  compareJobA.addEventListener('change', applyCompareCascade);

  compareBtn.addEventListener('click', async () => {
    const jobIdA = compareJobA.value;
    const jobIdB = compareJobB.value;
    if (!jobIdA || !jobIdB) { alert('Pick both jobs'); return; }
    compareSummary.textContent = 'Running...';
    compareReportPre.textContent = '';
    compareCsvLink.hidden = true;
    try {
      const r = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIdA, jobIdB }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        compareSummary.innerHTML = `<div class="hint bad">${escapeHtml(body.error || ('HTTP ' + r.status))}</div>`;
        return;
      }
      const diag = (body.diagnostics || []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');
      compareSummary.innerHTML =
        `<div>comparable: <strong>${body.comparable}</strong>, semanticComparable: <strong>${body.semanticComparable}</strong></div>` +
        (diag ? `<ul style="margin:4px 0 0 1em;font-size:0.85rem;">${diag}</ul>` : '');
      // Fetch the rendered Markdown report and assign as textContent (escaped).
      const mdReq = await fetch(`/api/compare/${body.reportId}/file?path=comparison-report.md`);
      if (mdReq.ok) {
        compareReportPre.textContent = await mdReq.text();
      } else {
        compareReportPre.textContent = '(could not load comparison-report.md)';
      }
      compareCsvLink.hidden = false;
      compareCsvLink.href = `/api/compare/${body.reportId}/file?path=score-matrix.csv`;
    } catch (e) {
      compareSummary.innerHTML = `<div class="hint bad">${escapeHtml(e.message || String(e))}</div>`;
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  refreshTools();
  refreshJobs();
  refreshReuseEvalDropdown();
  refreshCompareDropdowns();
  setInterval(() => { refreshJobs(); refreshReuseEvalDropdown(); refreshCompareDropdowns(); }, 5000);
})();
