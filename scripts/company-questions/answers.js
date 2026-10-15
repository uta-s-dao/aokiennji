(() => {
  'use strict';
  const storageKey = 'aoki-company-questions:appgprj_6ad0c9aacbdc8191a7912199d93da57f:notes:v1';
  const status = document.getElementById('draft-status');
  const progress = document.getElementById('answer-progress');
  const general = document.getElementById('general-note');
  const preview = document.getElementById('memo-preview');
  const previewText = document.getElementById('memo-text');
  const cards = Array.from(document.querySelectorAll('.question')).map((node) => ({
    id: node.querySelector('.question-id').textContent.trim(),
    title: node.querySelector('h2').textContent.trim(),
    question: Array.from(node.querySelectorAll('.question-text'))
      .map((p) => p.textContent)
      .join('\n'),
    input: node.querySelector('.answer-input'),
    confirmed: node.querySelector('.answer-confirmed'),
    badge: node.querySelector('.status'),
    print: node.querySelector('.answer-print'),
  }));
  const answers = Object.create(null);
  let dirty = false;
  let timer;
  const notify = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('save-error', error);
  };
  const text = (value) => (typeof value === 'string' ? value.slice(0, 20000) : '');

  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (
        draft?.schemaVersion !== 1 ||
        !draft.answers ||
        typeof draft.answers !== 'object' ||
        Array.isArray(draft.answers)
      )
        throw Error('invalid_draft');
      for (const [id, item] of Object.entries(draft.answers).slice(0, 1000)) {
        if (!/^Q\d+$/.test(id) || !item || typeof item !== 'object') continue;
        answers[id] = { text: text(item.text), confirmed: item.confirmed === true };
      }
      general.value = text(draft.generalNote);
      notify('このブラウザーに保存したメモを読み込みました。');
    } catch {
      notify(
        '保存したメモを読み込めませんでした。入力した内容はダウンロードして残してください。',
        true,
      );
    }
  }

  function update() {
    let filled = 0;
    let confirmed = 0;
    for (const card of cards) {
      const value = answers[card.id];
      const hasText = !!value?.text.trim();
      if (hasText) filled++;
      if (hasText && value.confirmed) confirmed++;
      card.badge.textContent = hasText
        ? value.confirmed
          ? '会社に確認済み'
          : 'メモあり'
        : '未記入';
      card.badge.classList.toggle('confirmed', hasText && value.confirmed);
      card.print.textContent = value?.text || '（未記入）';
    }
    progress.textContent =
      '入力済み ' + filled + '/' + cards.length + '件・会社に確認済み ' + confirmed + '件';
    document.getElementById('general-print').textContent = general.value || '（未記入）';
    if (preview.open) previewText.value = memo();
  }

  function persist() {
    clearTimeout(timer);
    if (!dirty) return;
    const now = new Date().toISOString();
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ schemaVersion: 1, savedAt: now, answers, generalNote: general.value }),
      );
      dirty = false;
      notify(
        'このブラウザーに保存しました。' +
          new Date(now).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }),
      );
    } catch {
      notify(
        'このブラウザーへの保存ができません。「回答メモをダウンロード」で内容を残してください。',
        true,
      );
    }
  }

  function changed() {
    dirty = true;
    update();
    clearTimeout(timer);
    notify('メモを保存中…');
    timer = setTimeout(persist, 250);
  }

  function memo() {
    const output = [
      '# アオキエンジ様への回答メモ',
      '',
      '書き出し日時：' + new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      '「会社に確認済み」の印がない内容は、確認前のメモです。',
      '',
    ];
    for (const card of cards) {
      const value = answers[card.id];
      output.push(
        '## ' + card.id + '　' + card.title,
        '',
        card.question,
        '',
        '確認状況：' + (value?.text.trim() && value.confirmed ? '会社に確認済み' : '確認前'),
        '回答・メモ：',
        value?.text.trim() ? value.text : '（未記入）',
        '',
      );
    }
    const known = new Set(cards.map((card) => card.id));
    for (const [id, value] of Object.entries(answers)) {
      if (!known.has(id) && value.text.trim())
        output.push(
          '## ' + id + '　以前の質問へのメモ',
          '',
          '確認状況：' + (value.confirmed ? '会社に確認済み' : '確認前'),
          value.text,
          '',
        );
    }
    output.push('## その他のメモ', '', general.value.trim() ? general.value : '（未記入）', '');
    return output.join('\n');
  }

  load();
  for (const card of cards) {
    if (!answers[card.id])
      answers[card.id] = { text: card.input.value, confirmed: card.confirmed.checked };
    card.input.value = answers[card.id].text;
    card.confirmed.checked = answers[card.id].confirmed;
    card.input.addEventListener('input', () => {
      const value = card.input.value;
      if (!value.trim()) card.confirmed.checked = false;
      answers[card.id] = { text: value, confirmed: card.confirmed.checked };
      changed();
    });
    card.confirmed.addEventListener('change', () => {
      answers[card.id] = { text: card.input.value, confirmed: card.confirmed.checked };
      changed();
    });
  }
  general.addEventListener('input', changed);
  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
  update();

  document.querySelectorAll('[data-action="download-memo"]').forEach((button) =>
    button.addEventListener('click', () => {
      persist();
      const blob = new Blob([memo()], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        'アオキエンジ_回答メモ_' +
        new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }) +
        '.md';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      document.getElementById('transfer-status').textContent =
        'ダウンロードした回答メモを、このチャットに添付してください。';
    }),
  );
  document.querySelectorAll('[data-action="copy-memo"]').forEach((button) =>
    button.addEventListener('click', async () => {
      persist();
      const value = memo();
      try {
        await navigator.clipboard.writeText(value);
        document.getElementById('transfer-status').textContent =
          '回答メモをコピーしました。このチャットに貼り付けてください。';
      } catch {
        preview.open = true;
        previewText.value = value;
        previewText.focus();
        previewText.select();
        document.getElementById('transfer-status').textContent =
          '回答メモを表示しました。選択された文章をコピーするか、ダウンロードしてチャットに渡してください。';
      }
    }),
  );
  preview.addEventListener('toggle', () => {
    if (preview.open) previewText.value = memo();
  });
  document.getElementById('print').addEventListener('click', () => {
    update();
    window.print();
  });
})();
