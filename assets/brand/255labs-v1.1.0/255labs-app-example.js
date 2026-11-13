// The same dependency-free behavior is distributed with the standalone example.
(() => {
  document.querySelectorAll('[data-brand-demo]').forEach(root => {
    const find = selector => root.querySelector(selector);
    const initial = [
      { name: 'Onboarding copy', project: 'Website', state: 'review' },
      { name: 'Release notes', project: 'Product', state: 'ready' },
      { name: 'Import permissions', project: 'Product', state: 'blocked' },
    ];
    let items = initial.map(item => ({ ...item }));
    const labels = { review: 'Needs review', ready: 'Ready', blocked: 'Blocked' };
    const styles = { review: 'info', ready: 'success', blocked: 'warning' };
    const announce = text => { find('[data-demo-feedback]').textContent = text; };
    function render() {
      const state = find('[data-demo-state]').value;
      const filter = find('[data-demo-filter]').value;
      const visible = state === 'empty' ? [] : items.filter(item => filter === 'all' || item.state === filter);
      const ready = state === 'ready' || state === 'empty';
      find('[data-demo-table]').hidden = !ready || !visible.length;
      find('[data-demo-empty]').hidden = !ready || !!visible.length;
      find('[data-demo-loading]').hidden = state !== 'loading';
      find('[data-demo-error]').hidden = state !== 'error';
      const rows = find('[data-demo-rows]');
      rows.replaceChildren();
      visible.forEach(item => {
        const row = document.createElement('tr');
        const name = document.createElement('td'); name.textContent = item.name;
        const project = document.createElement('td'); project.textContent = item.project;
        const status = document.createElement('td');
        const badge = document.createElement('span'); badge.className = `brand-badge ${styles[item.state]}`; badge.textContent = labels[item.state]; status.append(badge);
        const action = document.createElement('td');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'brand-button secondary';
        button.textContent = item.state === 'ready' ? 'Reopen' : item.state === 'blocked' ? 'Unblock' : 'Approve';
        button.setAttribute('aria-label', `${button.textContent} ${item.name}`);
        button.addEventListener('click', () => {
          const index = items.indexOf(item);
          item.state = item.state === 'ready' ? 'review' : 'ready';
          render(); announce(`${item.name}: ${labels[item.state]}.`);
          const next = rows.querySelectorAll('button')[Math.min(index, rows.children.length - 1)];
          (next || find('[data-demo-filter]')).focus();
        });
        action.append(button); row.append(name, project, status, action); rows.append(row);
      });
    }
    function showAll() { find('[data-demo-state]').value = 'ready'; find('[data-demo-filter]').value = 'all'; render(); }
    find('[data-demo-theme]').addEventListener('change', event => { root.dataset.brandTheme = event.target.value; });
    find('[data-demo-state]').addEventListener('change', render);
    find('[data-demo-filter]').addEventListener('change', () => { render(); announce(`${find('[data-demo-rows]').children.length} matching items.`); });
    find('[data-demo-show-all]').addEventListener('click', () => { showAll(); find('[data-demo-filter]').focus(); });
    root.querySelectorAll('[data-demo-retry]').forEach(button => button.addEventListener('click', () => { showAll(); announce('Example queue loaded.'); find('[data-demo-filter]').focus(); }));
    find('[data-demo-form]').addEventListener('submit', event => {
      event.preventDefault();
      const input = find('[data-demo-name]'); const name = input.value.trim();
      const error = find('#demo-name-error'); error.hidden = !!name;
      input.setAttribute('aria-invalid', String(!name));
      if (!name) { input.focus(); return; }
      items.push({ name, project: 'Workspace', state: 'review' }); input.value = ''; showAll(); announce(`Added ${name}.`); input.focus();
    });
    find('[data-demo-name]').addEventListener('input', event => {
      if (event.target.value.trim()) { event.target.removeAttribute('aria-invalid'); find('#demo-name-error').hidden = true; }
    });
    find('[data-demo-reset]').addEventListener('click', () => {
      items = initial.map(item => ({ ...item })); find('[data-demo-form]').reset();
      find('[data-demo-name]').removeAttribute('aria-invalid'); find('#demo-name-error').hidden = true;
      showAll(); announce('Example reset to three sample items.');
    });
    render();
  });
})();
