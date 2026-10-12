(function () {
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    const rows = document.getElementById('recordsRows');
    const count = document.getElementById('recordsCount');
    const message = document.getElementById('recordsMessage');
    const search = document.getElementById('recordsSearch');
    const refresh = document.getElementById('recordsRefreshButton');
    let records = [];
    let loading = false;
    let accessible = true;
    let fingerprint;

    const render = () => {
      const query = search.value.trim().toLowerCase();
      const visible = records.filter((record) => [record.id, record.status, record.supplierName, record.materialName]
        .some((value) => String(value || '').toLowerCase().includes(query)));
      count.textContent = String(visible.length);
      rows.replaceChildren();
      if (!visible.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.className = 'records-empty';
        cell.textContent = records.length ? 'No records match your search.' : 'No PCN records are available.';
        row.append(cell);
        rows.append(row);
        return;
      }
      visible.forEach((record) => {
        const row = document.createElement('tr');
        const code = document.createElement('td');
        const link = document.createElement('a');
        link.href = `/${encodeURIComponent(record.id)}`;
        link.textContent = record.id;
        code.append(link);
        row.append(code);
        const updated = record.updatedAt || record.createdAt;
        const updatedText = updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toLocaleDateString() : '—';
        [record.status, record.riskLevel, record.supplierName, record.materialName, updatedText]
          .forEach((value) => {
            const cell = document.createElement('td');
            cell.textContent = value || '—';
            row.append(cell);
          });
        rows.append(row);
      });
    };

    const load = async ({quiet = false,isCurrent = () => true} = {}) => {
      if (loading || !accessible) return;
      loading = true;
      refresh.disabled = true;
      if (!quiet) message.textContent = 'Loading records...';
      try {
        const result = await window.PCN_SESSION.fetch('/api/pcns');
        if (!isCurrent()) return;
        if (!Array.isArray(result)) throw new Error('The records list could not be loaded.');
        const nextFingerprint = JSON.stringify(result);
        if (fingerprint !== nextFingerprint) {
          const focusedId = document.activeElement?.closest?.('a')?.getAttribute('href');
          const scroll = {x:window.scrollX,y:window.scrollY};
          records = result;
          fingerprint = nextFingerprint;
          render();
          if (focusedId) Array.from(rows.querySelectorAll('a')).find(link => link.getAttribute('href') === focusedId)?.focus({preventScroll:true});
          window.scrollTo?.(scroll.x,scroll.y);
        }
        message.textContent = `${records.length} PCN record${records.length === 1 ? '' : 's'} available.`;
      } catch (error) {
        if (!isCurrent()) return;
        if ([401,403].includes(error.status)) {
          accessible = false;
          records = [];fingerprint = undefined;rows.replaceChildren();count.textContent = '0';
          document.getElementById('recordsWorkspace').hidden = true;
          const gateError = document.getElementById('recordsGateError');
          gateError.textContent = 'Your access has changed. Reload the page to continue.';gateError.hidden = false;
        }
        message.textContent = error.message;
        if (quiet) throw error;
      } finally {
        loading = false;
        refresh.disabled = false;
      }
    };

    try {
      const session = await window.PCN_SESSION.require();
      if (!session) return;
      const roles = Array.isArray(session.user?.roles) ? session.user.roles : [];
      if (roles.length) {
        window.location.assign('/admin');
        return;
      }
      if (!['employee-code', 'pcn-local'].includes(session.user?.identityProvider) || !session.user.employeeCode || session.user.isActive === false) {
        throw new Error('Records access requires verified employee sign-in.');
      }
      window.PCN_SESSION.mountProfile(session.user, (error) => { message.textContent = error.message; });
      document.getElementById('recordsWorkspace').hidden = false;
      document.getElementById('recordsAccessMessage').textContent = 'You have read-only access. Select a PCN code to view its details. An assigned role enables editing and Portal access.';
      search.addEventListener('input', render);
      refresh.addEventListener('click', () => load());
      await load();
      window.PCN_AUTO_REFRESH?.start({refresh:context => load({...context,quiet:true}),
        canRefresh:() => !loading && accessible,intervalMs:5000});
    } catch (error) {
      const gateError = document.getElementById('recordsGateError');
      gateError.textContent = error.message;
      gateError.hidden = false;
    }
  }
})();
