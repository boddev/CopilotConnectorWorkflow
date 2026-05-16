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
    document.getElementById('m365eval-fields').hidden = !provision;
    authFields.querySelectorAll('input').forEach((el) => {
      if (el.type !== 'checkbox') el.required = provision && ['tenantId','clientId'].includes(el.name);
    });
  });
  document.getElementById('run-m365-eval-cb').addEventListener('change', (e) => {
    document.getElementById('m365eval-detail').hidden = !e.target.checked;
    const agent = form.querySelector('[name=m365AgentId]');
    if (agent) agent.required = e.target.checked;
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
      li.textContent = `${j.id} — ${j.status}`;
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
    const stepOrder = ['evalgen','enhance','schema','connector','deploy','m365eval'];
    const rows = stepOrder.map((n) => {
      const s = job.steps[n] || { status: 'pending' };
      return `<div class="step-row"><span>${n}</span><span class="status status-${s.status}">${s.status}${s.errorMessage ? ' — ' + escapeHtml(s.errorMessage) : ''}</span></div>`;
    }).join('');
    const artifacts = collectArtifacts(job);
    const artLinks = artifacts.map((p) => `<a class="artifact-link" href="/api/jobs/${job.id}/file?path=${encodeURIComponent(p)}" target="_blank">${escapeHtml(p)}</a>`).join('');
    const resumeBtn = `<button id="resume-btn">Resume / re-run</button>
      <label style="display:inline-block;margin-left:8px;font-size:0.8rem;"><input type="checkbox" id="force-check"> force all</label>`;
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
      await fetch(`/api/jobs/${job.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll }),
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
      runM365Eval: form.querySelector('[name=runM365Eval]')?.checked || false,
    };
    if (payload.mode === 'provision') {
      payload.auth = {
        tenantId: data.tenantId,
        clientId: data.clientId,
        clientSecretEnvVar: data.clientSecretEnvVar || undefined,
        useManagedIdentity: form.querySelector('[name=useManagedIdentity]').checked,
      };
    }
    if (payload.runM365Eval) {
      payload.m365Eval = {
        agentId: data.m365AgentId,
        systemPromptFile: data.m365SystemPromptFile || undefined,
        evaluators: data.m365Evaluators ? data.m365Evaluators.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        concurrency: data.m365Concurrency ? Number(data.m365Concurrency) : undefined,
        environment: data.m365Environment || undefined,
        packageVersion: data.m365PackageVersion || undefined,
        logLevel: data.m365LogLevel || undefined,
        acceptEula: form.querySelector('[name=m365AcceptEula]')?.checked || false,
      };
    }
    const r = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { const err = await r.json().catch(() => ({})); alert('Failed: ' + (err.error || r.status)); return; }
    const job = await r.json();
    activeJobId = job.id;
    await refreshJobs();
    await selectJob(job.id);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  refreshTools();
  refreshJobs();
  setInterval(refreshJobs, 5000);
})();
