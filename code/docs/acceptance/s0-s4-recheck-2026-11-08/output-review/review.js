'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const displayTitle = title => /^Figure (None|null)\b/.test(title || '') ? '未确认图号的图像区域（原页参考，未配给本条）' : title;
  const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}' : JSON.stringify(value);
  const verdicts = [['looks_correct', '看起来正确'], ['has_problem', '有问题'], ['cannot_judge', '无法判断']];
  const issues = [['missing', '语境遗漏'], ['order', '原文或顺序有误'], ['row_column', '不像目标描述'], ['incomplete_figure', '图不完整或缺图'], ['wrong_figure', '配错图'], ['other', '其他']];

  async function digestText(text) {
    const bytes = new TextEncoder().encode(text);
    if (globalThis.crypto?.subtle) {
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    }
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const data = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64), words = new Int32Array(64);
    data.set(bytes); data[bytes.length] = 0x80;
    const dv = new DataView(data.buffer), rotate = (v,n) => (v >>> n) | (v << (32-n));
    dv.setUint32(data.length-8, Math.floor(bytes.length / 0x20000000), false);
    dv.setUint32(data.length-4, (bytes.length * 8) >>> 0, false);
    for (let offset=0; offset<data.length; offset+=64) {
      for (let i=0;i<16;i++) words[i] = dv.getUint32(offset+i*4, false);
      for (let i=16;i<64;i++) {
        const x=words[i-15], y=words[i-2], s0=rotate(x,7)^rotate(x,18)^(x>>>3), s1=rotate(y,17)^rotate(y,19)^(y>>>10);
        words[i] = (words[i-16]+s0+words[i-7]+s1)|0;
      }
      let [a,b,c,d,e,f,g,z] = h;
      for (let i=0;i<64;i++) {
        const t1=(z+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+k[i]+words[i])|0;
        const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))|0;
        z=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      [a,b,c,d,e,f,g,z].forEach((v,i) => h[i]=(h[i]+v)>>>0);
    }
    return [...h].map(v=>v.toString(16).padStart(8,'0')).join('');
  }

  let pack, storageKey, currentId, selectedPage, view = 'after', zoom = 100;
  let answers = {}, canStore = true;
  const element = (name, className, text) => { const node = document.createElement(name); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const keyOf = (caseId, questionId) => caseId + '::' + questionId;
  const currentCase = () => pack.cases.find(c => c.case_id === currentId);
  const questionCount = () => pack.cases.reduce((n, c) => n + c.questions.length, 0);
  const asset = path => { if (typeof path !== 'string' || !path.startsWith('assets/') || path.includes('..') || path.includes(':')) throw new Error('资料路径不可用。'); return path; };
  function message(text, error = false) { $('message').textContent = text; $('message').className = 'message' + (error ? ' error' : ''); }
  function payload() {
    return { schema_version: 'current-output-review-opinions-1', pack_id: pack.pack_id, pack_sha256: pack.pack_sha256,
      questionnaire_version: pack.questionnaire_version, plan_sha256: pack.plan_sha256, execution_report_sha256: pack.execution_report_sha256, exported_at: new Date().toISOString(), review_scope: 'current_model_output_ordinary_screening', browser_origin: location.origin,
      human_approved: false, medical_quality_approved: false, product_export_approved: false,
      opinions: Object.values(answers).filter(a => a.verdict || a.note || a.location || a.problem_types.length) };
  }
  function validateOpinions(value) {
    if (!value || value.schema_version !== 'current-output-review-opinions-1' || value.pack_id !== pack.pack_id || value.pack_sha256 !== pack.pack_sha256)
      throw new Error('资料版本不一致，未导入。请保留这份文件，勿将旧版本意见套用到本次资料。');
    if (value.questionnaire_version !== pack.questionnaire_version || value.plan_sha256 !== pack.plan_sha256 || value.execution_report_sha256 !== pack.execution_report_sha256) throw new Error('运行或问卷版本不一致，未导入。');
    if (value.review_scope !== 'current_model_output_ordinary_screening' || value.human_approved !== false || value.medical_quality_approved !== false || value.product_export_approved !== false)
      throw new Error('文件不属于本轮模型输出普通初筛，未导入。');
    if (!Array.isArray(value.opinions) || value.opinions.length > questionCount()) throw new Error('意见数量或格式不正确，未导入。');
    const next = {};
    for (const opinion of value.opinions) {
      if (!opinion || typeof opinion !== 'object') throw new Error('意见格式不正确，未导入。');
      const c = pack.cases.find(c => c.case_id === opinion.case_id), q = c && c.questions.find(q => q.question_id === opinion.question_id);
      if (!c || !q || opinion.source_id !== c.source_id || opinion.pdf_sha256 !== c.pdf_sha256 || opinion.artifact_sha256 !== c.artifact_sha256 || opinion.case_version !== c.case_version || stable(opinion.source_binding) !== stable(c.source_binding))
        throw new Error('意见对应的论文或案例版本不一致，未导入。');
      const key = keyOf(c.case_id, q.question_id);
      if (next[key] || (opinion.verdict !== null && !verdicts.some(v => v[0] === opinion.verdict)) ||
        !Array.isArray(opinion.problem_types) || opinion.problem_types.length > issues.length ||
        opinion.problem_types.some(v => !issues.some(i => i[0] === v)) || new Set(opinion.problem_types).size !== opinion.problem_types.length ||
        typeof opinion.location !== 'string' || opinion.location.length > 300 || typeof opinion.note !== 'string' || opinion.note.length > 4000)
        throw new Error('意见选项或备注格式不正确，未导入。');
      next[key] = { case_id: c.case_id, question_id: q.question_id, source_id: c.source_id, pdf_sha256: c.pdf_sha256,
        artifact_sha256: c.artifact_sha256, case_version: c.case_version, source_binding: c.source_binding, verdict: opinion.verdict,
        problem_types: [...opinion.problem_types], location: opinion.location, note: opinion.note,
        updated_at: typeof opinion.updated_at === 'string' ? opinion.updated_at.slice(0, 50) : null };
    }
    return next;
  }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(payload())); canStore = true; }
    catch { canStore = false; message('当前浏览器无法保存进度，请及时导出审核意见。', true); }
    updateProgress(); renderCases();
  }
  function updateProgress() {
    const done = Object.values(answers).filter(a => a.verdict).length;
    $('progress').textContent = '本次核验进度：' + done + ' / ' + questionCount() + ' 项' + (canStore ? ' · 本浏览器已保存' : ' · 请导出备份');
  }
  function visibleCases() { return pack.cases.filter(c => $('kind-filter').value === 'all' || c.kind === $('kind-filter').value); }
  function renderCases() {
    const list = $('case-list'); list.replaceChildren();
    for (const c of visibleCases()) {
      const done = c.questions.filter(q => answers[keyOf(c.case_id, q.question_id)]?.verdict).length;
      const button = element('button', 'case-button', c.title); button.type = 'button'; button.dataset.caseId = c.case_id;
      button.setAttribute('aria-current', String(c.case_id === currentId));
      button.append(element('small', '', c.source_id + ' · 第' + c.pages.map(p => p.physical_page).join('、') + '页 · ' + done + '/' + c.questions.length + '项'));
      button.addEventListener('click', () => selectCase(c.case_id)); list.append(button);
    }
  }
  function openImage(path, title) { $('zoom-image').src = asset(path); $('zoom-title').textContent = title; zoom = 100; updateZoom(); $('image-dialog').showModal(); }
  function updateZoom() { $('zoom-image').style.width = zoom + '%'; $('zoom-level').textContent = zoom + '%'; }
  function imageBlock(path, title) {
    title = displayTitle(title);
    const button = element('button', 'image-button'); button.type = 'button'; button.setAttribute('aria-label', title + '，点击放大');
    const img = element('img'); img.src = asset(path); img.alt = title; img.loading = 'lazy'; button.append(img);
    button.addEventListener('click', () => openImage(path, title)); return button;
  }
  function setPage(pageNumber) {
    const c = currentCase(), page = c.pages.find(p => p.physical_page === pageNumber) || c.pages[0]; selectedPage = page.physical_page;
    $('page-select').value = String(selectedPage); $('original-image').src = asset(page.image); $('original-image').alt = c.source_id + ' 原PDF第' + selectedPage + '页，点击放大';
    $('original-pdf').href = asset(c.pdf) + '#page=' + selectedPage;
  }
  function tableBlock(grid) {
    const wrapper = element('div'), controls = element('div', 'table-controls');
    const scroll = element('div', 'table-scroll'), table = element('table', 'readable-table'), occupied = new Set();
    const rows = Math.min(200, Number(grid.n_rows) || 0), columns = Math.min(30, Number(grid.n_cols) || 0);
    controls.append(element('p', 'hint', '共' + rows + '行×' + columns + '列（含表头），可在表格内上下/左右滚动。'));
    const expand = element('button', 'secondary', '展开全表'); expand.type = 'button'; expand.setAttribute('aria-expanded', 'false');
    expand.addEventListener('click', () => { const full = expand.getAttribute('aria-expanded') !== 'true';
      scroll.style.maxHeight = full ? 'none' : ''; expand.setAttribute('aria-expanded', String(full)); expand.textContent = full ? '收起' : '展开全表'; });
    controls.append(expand); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '可上下和左右滚动的原文表格');
    for (let r = 0; r < rows; r++) {
      const row = element('tr');
      for (let col = 0; col < columns; col++) {
        if (occupied.has(r + ':' + col)) continue;
        const cell = grid.cells.find(c => c.row_start === r && c.col_start === col);
        const td = element(cell && (cell.column_header || cell.row_header) ? 'th' : 'td', cell?.pending ? 'pending-cell' : '', cell ? String(cell.text ?? '') : '');
        if (cell) {
          td.rowSpan = Math.max(1, Math.min(rows - r, cell.row_end - r)); td.colSpan = Math.max(1, Math.min(columns - col, cell.col_end - col));
          for (let rr = r; rr < r + td.rowSpan; rr++) for (let cc = col; cc < col + td.colSpan; cc++) occupied.add(rr + ':' + cc);
        }
        row.append(td);
      }
      table.append(row);
    }
    scroll.append(table); wrapper.append(controls, scroll); return wrapper;
  }
  function renderParsed() {
    const c = currentCase(), sections = c[view]?.sections || [], holder = $('parsed-view'); holder.replaceChildren();
    $('view-after').setAttribute('aria-pressed', String(view === 'after')); $('view-before').setAttribute('aria-pressed', String(view === 'before'));
    $('view-before').disabled = !c.before;
    $('version-note').textContent = view === 'after' ? c.after_note : (c.before_note || '此前结果，仅供同一原页对照。');
    for (const section of sections) {
      const node = element(section.collapsed ? 'details' : 'section', 'parsed-section'); if (section.title) node.append(element(section.collapsed ? 'summary' : 'h4', '', displayTitle(section.title)));
      if (section.type === 'image') node.append(imageBlock(section.image, section.title || '解析图像'));
      if (section.type === 'text') node.append(element('pre', 'original-text', section.text));
      if (section.type === 'table') node.append(tableBlock(section.grid));
      if (section.type === 'fragments') {
        let caption, previous;
        for (const [index, fragment] of section.fragments.entries()) {
          if (section.layout === 'caption-lines') {
            if (!caption || previous.physical_page !== fragment.physical_page || fragment.break_before || previous.label !== fragment.label) {
              const label = element('p', 'fragment-label', '原PDF第' + fragment.physical_page + '页' + (fragment.label ? ' · ' + fragment.label : ''));
              const jump = element('button', 'secondary', '对照此页'); jump.type = 'button'; jump.addEventListener('click', () => setPage(fragment.physical_page)); label.append(jump);
              caption = element('pre', 'original-text caption-lines'); node.append(label, caption);
            } else caption.append(document.createTextNode('\n'));
            const line = element('span', 'caption-line', fragment.text); line.dataset.fragmentIndex = String(index);
            caption.append(line); previous = fragment;
          } else {
            const label = element('p', 'fragment-label', (index + 1) + ' · 原PDF第' + fragment.physical_page + '页' + (fragment.label ? ' · ' + fragment.label : ''));
            const jump = element('button', 'secondary', '对照此页'); jump.type = 'button'; jump.addEventListener('click', () => setPage(fragment.physical_page)); label.append(jump);
            node.append(label, element('pre', 'original-text', fragment.text));
          }
        }
      }
      for (const im of section.images || []) node.append(imageBlock(im.image, im.title));
      if (section.note) node.append(element('p', 'hint', section.note)); holder.append(node);
    }
  }
  function record(c, q) {
    const key = keyOf(c.case_id, q.question_id);
    if (!answers[key]) answers[key] = { case_id: c.case_id, question_id: q.question_id, source_id: c.source_id, pdf_sha256: c.pdf_sha256,
      artifact_sha256: c.artifact_sha256, case_version: c.case_version, source_binding: c.source_binding, verdict: null, problem_types: [], location: '', note: '', updated_at: null };
    return answers[key];
  }
  function changed(answer) { answer.updated_at = new Date().toISOString(); save(); }
  function renderQuestions() {
    const c = currentCase(), container = $('questions'); container.replaceChildren();
    for (const q of c.questions) {
      const answer = record(c, q), card = element('fieldset', 'opinion-card'); card.dataset.questionId = q.question_id;
      card.append(element('legend', '', q.text)); if (q.hint) card.append(element('p', 'hint', q.hint));
      const buttons = element('div', 'verdict-buttons'), types = element('div', 'issue-types');
      types.hidden = !answer.verdict || answer.verdict === 'looks_correct';
      for (const [value, label] of verdicts) {
        const button = element('button', '', label); button.type = 'button'; button.dataset.verdict = value; button.setAttribute('aria-pressed', String(answer.verdict === value));
        button.addEventListener('click', () => { answer.verdict = value; types.hidden = value === 'looks_correct';
          buttons.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.verdict === value))); changed(answer); }); buttons.append(button);
      }
      for (const [value, label] of issues) {
        const wrapper = element('label'), input = element('input'); input.type = 'checkbox'; input.value = value; input.checked = answer.problem_types.includes(value);
        input.addEventListener('change', () => { answer.problem_types = [...types.querySelectorAll('input:checked')].map(i => i.value); changed(answer); }); wrapper.append(input, document.createTextNode(label)); types.append(wrapper);
      }
      const fields = element('div', 'opinion-fields'), locationLabel = element('label', '', '问题位置（可选）'), noteLabel = element('label', '', '备注（可选）');
      const place = element('input'); place.type = 'text'; place.maxLength = 300; place.value = answer.location; place.placeholder = '例如：右栏第3行、面板D右边、表4第2行';
      const note = element('textarea'); note.maxLength = 4000; note.value = answer.note; note.placeholder = '请写明原文、语境、目标相关性或配图的问题；无法判断时可说明原因。';
      place.addEventListener('input', () => { answer.location = place.value; changed(answer); }); note.addEventListener('input', () => { answer.note = note.value; changed(answer); });
      locationLabel.append(place); noteLabel.append(note); fields.append(locationLabel, noteLabel); card.append(buttons, types, fields); container.append(card);
    }
  }
  function selectCase(id) {
    currentId = id; view = 'after'; const c = currentCase(); if (!c) return;
    $('case-category').textContent = ({ B0: '单独智能体 B0 · 当前候选', F: '正向预筛 F · 当前候选' })[c.kind];
    $('case-title').textContent = c.title; $('case-explanation').textContent = (c.explanation || '').replace(/\bneeds_context\b/g, '语境待核'); $('case-explanation').hidden = !c.explanation;
    $('page-select').replaceChildren(...c.pages.map(p => { const option = element('option', '', String(p.physical_page)); option.value = String(p.physical_page); return option; }));
    setPage(c.initial_page); renderParsed(); renderQuestions(); renderCases();
    const source = $('source-details'); source.replaceChildren();
    for (const line of ['论文：' + c.source_label, '物理页：' + c.pages.map(p => p.physical_page).join('、'), '本例资料版本：' + c.case_version,
      '原PDF指纹：' + c.pdf_sha256, '当前IR指纹：' + c.artifact_sha256, '代表运行：' + c.source_binding.run_id, '逻辑条件：' + c.source_binding.logical_job_ids.join(' / '), '候选ID/版本：' + c.source_binding.record_id + ' / ' + c.source_binding.record_version, '结果文件指纹：' + c.source_binding.result_sha256, c.source_binding.delivery_fingerprint ? '候选交付指纹：' + c.source_binding.delivery_fingerprint : '无合法交付指纹（校验拒绝）；原始待核视图指纹：' + c.source_binding.raw_view_fingerprint]) source.append(element('p', '', line));
    const visible = visibleCases(), index = visible.findIndex(v => v.case_id === id); $('previous').disabled = index <= 0; $('next').disabled = index < 0 || index >= visible.length - 1;
  }
  async function load() {
    $('origin').textContent = location.origin;
    if (location.protocol === 'file:') { message('请在 VSCode 中右键本目录的 index.html，选择 Open with Live Server，再进行核验。', true); return; }
    try {
      const response = await fetch('./data.json', { cache: 'no-store' }); if (!response.ok) throw new Error('本次资料读取失败，请确认使用完整的 output-review 目录。'); pack = await response.json();
      const { pack_sha256, ...bound } = pack;
      const computed = await digestText(stable(bound));
      if (computed !== pack_sha256) throw new Error('资料指纹校验失败，未加载或套用任何意见。');
      if (pack.schema_version !== 'current-output-review-pack-1' || !Array.isArray(pack.cases) || !pack.cases.length) throw new Error('本次核验资料尚未就绪。');
      $('pack-summary').textContent = '本轮 ' + pack.total_current_candidates + ' 条未审核候选，本页列出 ' + pack.cases.length + ' 条；' + (pack.sampling === 'all_current_candidates' ? '当前候选全列。' : '每实际运行固定种子最多6条，另列定向风险；非正式验收样本。') + ' 实际发起 ' + pack.actual_independent_runs_with_model_requests + ' 个独立输入运行，不表示全部完成；L01-F 与 L01-B0 共用结果和成本。';
      $('run-status').textContent = JSON.stringify({execution_status: pack.execution_status, logical_jobs: pack.logical_jobs}, null, 2);
      storageKey = 't1-current-output-review:' + pack.pack_id + ':' + pack.pack_sha256;
      try { const saved = localStorage.getItem(storageKey); if (saved) answers = validateOpinions(JSON.parse(saved)); }
      catch { message('此前保存的进度无法读取，未套用。请使用导入审核意见恢复备份。', true); }
      $('workspace').hidden = false; $('export').disabled = false; $('clear').disabled = false;
      const requested = decodeURIComponent(location.hash.slice(1));
      selectCase(pack.cases.some(c => c.case_id === requested) ? requested : pack.cases[0].case_id); updateProgress();
    } catch (error) { message(error.message || '资料读取失败。', true); }
  }
  $('kind-filter').addEventListener('change', () => { const visible = visibleCases(); if (visible.length && !visible.some(c => c.case_id === currentId)) selectCase(visible[0].case_id); else { renderCases(); if (currentId) selectCase(currentId); } });
  $('page-select').addEventListener('change', () => setPage(Number($('page-select').value)));
  $('original-image-button').addEventListener('click', () => { const p = currentCase().pages.find(p => p.physical_page === selectedPage); openImage(p.image, currentCase().source_id + ' 原PDF第' + selectedPage + '页'); });
  $('view-after').addEventListener('click', () => { view = 'after'; renderParsed(); }); $('view-before').addEventListener('click', () => { view = 'before'; renderParsed(); });
  for (const [button, delta] of [['previous', -1], ['next', 1]]) $(button).addEventListener('click', () => { const cases = visibleCases(), index = cases.findIndex(c => c.case_id === currentId); if (cases[index + delta]) selectCase(cases[index + delta].case_id); });
  $('zoom-close').addEventListener('click', () => $('image-dialog').close()); $('zoom-in').addEventListener('click', () => { zoom = Math.min(400, zoom + 50); updateZoom(); });
  $('zoom-out').addEventListener('click', () => { zoom = Math.max(50, zoom - 50); updateZoom(); }); $('zoom-reset').addEventListener('click', () => { zoom = 100; updateZoom(); });
  $('export').addEventListener('click', () => { if (!pack) return; const blob = new Blob([JSON.stringify(payload(), null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = '本轮输出核验意见-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('审核意见已导出到浏览器下载位置；可手动放回本页同目录。网页未写入远端服务器。'); });
  $('import').addEventListener('change', async event => { const file = event.target.files[0]; if (!file || !pack) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error('文件过大，未导入。'); const next = validateOpinions(JSON.parse(await file.text()));
      answers = next; save(); renderQuestions(); message('已恢复这份文件中同一资料版本的审核意见。'); }
    catch (error) { message(error.message || '文件格式不正确，未导入。', true); } finally { event.target.value = ''; } });
  $('clear').addEventListener('click', () => { if (!pack || !confirm('清空本浏览器中本次资料的核验记录？请先导出需要保留的审核意见。')) return; answers = {}; save(); renderQuestions(); message('已清空本次记录；服务器与此前导出的文件未变。'); });
  load();
})();
