class SuperError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'SuperError';
        this.status = status;
    }
}

class SuperDashboard {
    constructor() {
        this.baseUrl = GeoSession.apiRoot();
        this.confirmResolver = null;
        this.admins = [];
        this.organizations = [];
        this.pageCopy = {
            overview: ['Overview', 'Organizations on Geo-Lo and how they are using the product'],
            organizations: ['Organizations', 'Hook companies onto Geo-Lo and suspend access if needed'],
            admins: ['Org admins', 'Create the people who track workers for each organization'],
            sessions: ['Sessions', 'Who is signed in across the platform'],
            directory: ['Directory', 'Workers across organizations'],
            security: ['Security', 'Failed punches and device rules across the platform'],
            audit: ['Audit', 'Owner activity and organization changes']
        };
        this.init();
    }

    async init() {
        const allowed = await GeoSession.assertSuperAdmin();
        if (!allowed) {
            window.location.replace(GeoSession.getRole() === 'admin' ? 'admin.php' : 'super-login.html?denied=1');
            return;
        }
        document.body.classList.add('admin-ok');
        document.body.classList.remove('admin-pending');
        const user = GeoSession.getUser();
        const chip = document.getElementById('youChip');
        if (chip && user) chip.textContent = user.name || 'Geo-Lo owner';
        this.applyStoredTheme();
        this.setupThemeToggle();
        this.setupMobileNav();
        this.setupConfirmModal();
        this.setupTabs();
        this.setupEvents();
        await this.loadOverview();
    }

    applyStoredTheme() {
        const theme = localStorage.getItem('geo_theme') || 'dark';
        document.body.classList.toggle('light', theme === 'light');
    }

    setupThemeToggle() {
        document.getElementById('themeToggle')?.addEventListener('click', () => {
            document.body.classList.toggle('light');
            localStorage.setItem('geo_theme', document.body.classList.contains('light') ? 'light' : 'dark');
        });
    }

    setupMobileNav() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const close = () => {
            sidebar?.classList.remove('open');
            overlay?.classList.remove('show');
        };
        document.getElementById('menuToggle')?.addEventListener('click', () => {
            sidebar?.classList.add('open');
            overlay?.classList.add('show');
        });
        overlay?.addEventListener('click', close);
        document.querySelectorAll('.menu-item').forEach((item) => item.addEventListener('click', close));
    }

    setupTabs() {
        const items = document.querySelectorAll('.menu-item');
        items.forEach((item) => {
            item.addEventListener('click', () => {
                items.forEach((i) => i.classList.remove('active'));
                item.classList.add('active');
                document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
                const tabId = item.getAttribute('data-tab');
                document.getElementById(tabId)?.classList.add('active');
                const copy = this.pageCopy[tabId];
                if (copy) {
                    const title = document.getElementById('pageTitle');
                    const subtitle = document.getElementById('pageSubtitle');
                    if (title) title.textContent = copy[0];
                    if (subtitle) subtitle.textContent = copy[1];
                }
                if (tabId === 'organizations') this.loadOrganizations();
                if (tabId === 'admins') this.loadAdmins();
                if (tabId === 'sessions') this.loadSessions();
                if (tabId === 'directory') this.loadWorkers();
                if (tabId === 'security') this.loadSecurity();
                if (tabId === 'audit') this.loadAudit();
            });
        });
    }

    setupEvents() {
        document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
        document.getElementById('retryOverviewBtn')?.addEventListener('click', () => this.loadOverview());
        document.getElementById('orgForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.createOrganization();
        });
        document.getElementById('refreshOrgsBtn')?.addEventListener('click', () => this.loadOrganizations(true));
        document.getElementById('adminForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.createAdmin();
        });
        document.getElementById('toggleAdminPassword')?.addEventListener('click', (e) => {
            const input = document.getElementById('adminPassword');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            e.currentTarget.textContent = show ? '🙈' : '👁️';
        });
        document.getElementById('refreshAdminsBtn')?.addEventListener('click', () => this.loadAdmins(true));
        document.getElementById('refreshSessionsBtn')?.addEventListener('click', () => this.loadSessions(true));
        document.getElementById('refreshWorkersBtn')?.addEventListener('click', () => this.loadWorkers(true));
        document.getElementById('refreshSecurityBtn')?.addEventListener('click', () => this.loadSecurity(true));
        document.getElementById('filterAuditBtn')?.addEventListener('click', () => this.loadAudit());
        document.getElementById('editAdminCancel')?.addEventListener('click', () => {
            document.getElementById('editAdminModal')?.classList.remove('show');
        });
        document.getElementById('editAdminSave')?.addEventListener('click', () => this.saveAdminEdit());
        ['adminName', 'adminEmail', 'adminPassword', 'adminOrg', 'orgName'].forEach((id) => {
            document.getElementById(id)?.addEventListener('input', () => this.clearFieldError(id));
        });
    }

    setupConfirmModal() {
        const backdrop = document.getElementById('confirmModal');
        const finish = (value) => {
            backdrop?.classList.remove('show');
            if (this.confirmResolver) {
                this.confirmResolver(value);
                this.confirmResolver = null;
            }
        };
        document.getElementById('confirmOk')?.addEventListener('click', () => finish(true));
        document.getElementById('confirmCancel')?.addEventListener('click', () => finish(false));
        backdrop?.addEventListener('click', (e) => { if (e.target === backdrop) finish(false); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && backdrop?.classList.contains('show')) finish(false);
        });
    }

    confirmDialog({ title = 'Confirm', message = 'Are you sure?', confirmText = 'Confirm', danger = true } = {}) {
        return new Promise((resolve) => {
            this.confirmResolver = resolve;
            const titleEl = document.getElementById('confirmTitle');
            const msgEl = document.getElementById('confirmMessage');
            const ok = document.getElementById('confirmOk');
            if (titleEl) titleEl.textContent = title;
            if (msgEl) msgEl.textContent = message;
            if (ok) {
                ok.textContent = confirmText;
                ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
            }
            document.getElementById('confirmModal')?.classList.add('show');
        });
    }

    escapeHtml(value) {
        if (value == null) return '';
        return String(value).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    toast(message, type = 'info', title) {
        const stack = document.getElementById('toastStack');
        if (!stack) return;
        const titles = { success: 'Success', error: 'Something went wrong', warning: 'Check this', info: 'Notice' };
        const icons = { success: '✓', error: '!', warning: '!', info: 'i' };
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `
            <div class="toast-icon">${icons[type] || 'i'}</div>
            <div class="toast-body">
                <div class="toast-title">${this.escapeHtml(title || titles[type] || 'Notice')}</div>
                <div class="toast-msg">${this.escapeHtml(message)}</div>
            </div>
            <button type="button" class="toast-close" aria-label="Dismiss">×</button>
        `;
        const remove = () => el.remove();
        el.querySelector('.toast-close')?.addEventListener('click', remove);
        stack.appendChild(el);
        setTimeout(remove, type === 'error' ? 7000 : 4200);
    }

    emptyState(title, message) {
        return `<div class="state-box"><h4>${this.escapeHtml(title)}</h4><p>${this.escapeHtml(message)}</p></div>`;
    }

    setFieldError(id, message) {
        const input = document.getElementById(id);
        const error = document.querySelector(`.field-error[data-for="${id}"]`);
        input?.classList.toggle('is-invalid', !!message);
        if (error) {
            error.textContent = message || '';
            error.classList.toggle('show', !!message);
        }
    }

    clearFieldError(id) {
        this.setFieldError(id, '');
    }

    setButtonLoading(btn, loading, label) {
        if (!btn) return;
        if (loading) {
            if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = `<span class="spinner"></span>${this.escapeHtml(label || 'Please wait...')}`;
        } else {
            btn.disabled = false;
            btn.innerHTML = btn.dataset.originalHtml || label || btn.innerHTML;
            delete btn.dataset.originalHtml;
        }
    }

    animateCount(el, value) {
        if (!el) return;
        el.textContent = String(Number(value) || 0);
    }

    formatWhen(value) {
        if (!value) return '—';
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? this.escapeHtml(value) : date.toLocaleString();
    }

    async parseJsonSafe(response) {
        try {
            return await response.json();
        } catch (e) {
            return { message: response.ok ? 'OK' : 'Request failed', error: !response.ok };
        }
    }

    async request(path, options = {}) {
        const { timeoutMs = 20000, headers, ...fetchOptions } = options;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl}/${path}`, {
                ...fetchOptions,
                signal: controller.signal,
                credentials: 'include',
                headers: {
                    ...GeoSession.headers(),
                    ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(headers || {})
                }
            });
            if (response.status === 401) {
                GeoSession.clear();
                window.location.replace('super-login.html?denied=1');
                throw new SuperError('Session expired. Please sign in again.');
            }
            if (response.status === 403) {
                window.location.replace('admin.php');
                throw new SuperError('Super admin access required.');
            }
            const data = await this.parseJsonSafe(response);
            if (!response.ok || (data && data.error)) {
                throw new SuperError(data.error || data.message || `Request failed (${response.status})`, response.status);
            }
            return data;
        } catch (error) {
            if (error instanceof SuperError) throw error;
            if (error.name === 'AbortError') throw new SuperError('The request timed out. Please try again.');
            throw new SuperError('Network error. Check your connection and try again.');
        } finally {
            clearTimeout(timeout);
        }
    }

    async loadOverview() {
        const banner = document.getElementById('overviewError');
        banner?.classList.remove('show');
        try {
            const data = await this.request('super.php?type=overview');
            const c = data.counts || {};
            this.animateCount(document.getElementById('statOrgs'), c.organizations);
            this.animateCount(document.getElementById('statOrgAdmins'), c.org_admins);
            this.animateCount(document.getElementById('statWorkers'), c.workers_active);
            this.animateCount(document.getElementById('statOnSite'), c.on_site);
            this.animateCount(document.getElementById('statSessions'), c.sessions_active);
            this.animateCount(document.getElementById('statFailed'), c.failed_punches_today);
            this.renderFeed(document.getElementById('overviewOrgs'), data.recent_organizations || [], (o) => ({
                title: o.name,
                meta: `${Number(o.is_active) === 1 ? 'Active' : 'Suspended'} · ${this.formatWhen(o.created_at)}`
            }), 'No organizations yet', 'Hook a company onto Geo-Lo to get started.');
            this.renderFeed(document.getElementById('overviewAudit'), data.recent_audit || [], (r) => ({
                title: `${r.action} ${r.entity || ''}`.trim(),
                meta: `${this.actorLabel(r)}${r.organization_name ? ' · ' + r.organization_name : ''} · ${this.formatWhen(r.created_at)}`
            }), 'No audit events', 'Owner activity and organization changes will appear here.');
        } catch (error) {
            banner?.classList.add('show');
            this.toast(error.message, 'error', 'Overview');
        }
    }

    actorLabel(row) {
        return row.actor_label || `${row.actor_role || 'system'} #${row.actor_id || '—'}`;
    }

    renderFeed(container, rows, formatter, emptyTitle, emptyMsg) {
        if (!container) return;
        if (!rows.length) {
            container.innerHTML = this.emptyState(emptyTitle, emptyMsg);
            return;
        }
        container.innerHTML = rows.map((row) => {
            const item = formatter(row);
            return `<div class="feed-item"><div>${this.escapeHtml(item.title)}</div><div class="feed-meta">${this.escapeHtml(item.meta)}</div></div>`;
        }).join('');
    }

    fillOrgSelects() {
        const options = '<option value="">Select organization</option>' + (this.organizations || []).map((o) =>
            `<option value="${o.id}">${this.escapeHtml(o.name)}</option>`).join('');
        ['adminOrg', 'editAdminOrg'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const current = el.value;
            el.innerHTML = options;
            if (current) el.value = current;
        });
    }

    async loadOrganizations(notify = false) {
        try {
            this.organizations = await this.request('super.php?type=organizations');
            this.displayOrganizations(Array.isArray(this.organizations) ? this.organizations : []);
            this.fillOrgSelects();
            if (notify) this.toast('Organizations updated.', 'success');
        } catch (error) {
            this.toast(error.message, 'error', 'Organizations');
        }
    }

    displayOrganizations(rows) {
        const tbody = document.querySelector('#orgsTable tbody');
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="6">${this.emptyState('No organizations', 'Hook a company onto Geo-Lo to get started.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = rows.map((o) => {
            const active = Number(o.is_active) === 1;
            return `
                <tr>
                    <td>${this.escapeHtml(o.name)}<div class="feed-meta">${this.escapeHtml(o.contact_email || o.notes || '')}</div></td>
                    <td>${this.escapeHtml(o.admin_count || 0)}</td>
                    <td>${this.escapeHtml(o.worker_count || 0)}</td>
                    <td>${this.escapeHtml(o.location_count || 0)}</td>
                    <td><span class="badge ${active ? 'badge-ok' : 'badge-off'}">${active ? 'Active' : 'Suspended'}</span></td>
                    <td>
                        <div class="row-actions">
                            ${active
                                ? `<button class="btn btn-danger btn-sm" type="button" data-suspend-org="${o.id}">Suspend</button>`
                                : `<button class="btn btn-success btn-sm" type="button" data-activate-org="${o.id}">Activate</button>`}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        tbody.querySelectorAll('[data-suspend-org]').forEach((btn) => {
            btn.addEventListener('click', () => this.setOrgActive(Number(btn.dataset.suspendOrg), false));
        });
        tbody.querySelectorAll('[data-activate-org]').forEach((btn) => {
            btn.addEventListener('click', () => this.setOrgActive(Number(btn.dataset.activateOrg), true));
        });
    }

    async createOrganization() {
        const name = document.getElementById('orgName')?.value.trim();
        this.clearFieldError('orgName');
        if (!name) {
            this.setFieldError('orgName', 'Organization name is required.');
            this.toast('Enter an organization name.', 'warning');
            return;
        }
        const payload = {
            action: 'create_organization',
            name,
            contact_email: document.getElementById('orgEmail')?.value.trim(),
            phone: document.getElementById('orgPhone')?.value.trim(),
            notes: document.getElementById('orgNotes')?.value.trim(),
            admin_name: document.getElementById('orgAdminName')?.value.trim(),
            admin_email: document.getElementById('orgAdminEmail')?.value.trim(),
            admin_password: document.getElementById('orgAdminPassword')?.value
        };
        const btn = document.getElementById('createOrgBtn');
        this.setButtonLoading(btn, true, 'Hooking…');
        try {
            const result = await this.request('super.php', { method: 'POST', body: JSON.stringify(payload) });
            this.toast(result.message || 'Organization hooked onto Geo-Lo.', 'success');
            document.getElementById('orgForm')?.reset();
            await this.loadOrganizations();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error', 'Could not hook organization');
        } finally {
            this.setButtonLoading(btn, false);
        }
    }

    async setOrgActive(id, active) {
        const ok = await this.confirmDialog({
            title: active ? 'Activate organization' : 'Suspend organization',
            message: active
                ? 'Admins and workers for this organization will be able to sign in again.'
                : 'Admins and workers will be signed out and blocked until you activate it again.',
            confirmText: active ? 'Activate' : 'Suspend',
            danger: !active
        });
        if (!ok) return;
        try {
            const result = await this.request('super.php', {
                method: 'PUT',
                body: JSON.stringify({ action: 'update_organization', id, is_active: active })
            });
            this.toast(result.message || 'Updated.', 'success');
            await this.loadOrganizations();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async loadAdmins(notify = false) {
        try {
            if (!this.organizations.length) {
                this.organizations = await this.request('super.php?type=organizations');
                this.fillOrgSelects();
            }
            this.admins = await this.request('super.php?type=admins');
            this.displayAdmins(Array.isArray(this.admins) ? this.admins : []);
            if (notify) this.toast('Org admin list updated.', 'success');
        } catch (error) {
            this.toast(error.message, 'error', 'Org admins');
        }
    }

    displayAdmins(admins) {
        const tbody = document.querySelector('#adminsTable tbody');
        if (!tbody) return;
        if (!admins.length) {
            tbody.innerHTML = `<tr><td colspan="6">${this.emptyState('No organization admins', 'Create an admin when you hook an organization.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = admins.map((admin) => {
            const active = Number(admin.is_active) === 1;
            return `
                <tr>
                    <td>${this.escapeHtml(admin.name)}</td>
                    <td>${this.escapeHtml(admin.email)}</td>
                    <td>${this.escapeHtml(admin.organization_name || '—')}</td>
                    <td><span class="badge ${active ? 'badge-ok' : 'badge-off'}">${active ? 'Active' : 'Inactive'}</span></td>
                    <td>${this.formatWhen(admin.last_seen)}</td>
                    <td>
                        <div class="row-actions">
                            <button class="btn btn-ghost btn-sm" type="button" data-edit-admin="${admin.id}">Edit</button>
                            ${active
                                ? `<button class="btn btn-danger btn-sm" type="button" data-deactivate-admin="${admin.id}">Deactivate</button>`
                                : `<button class="btn btn-success btn-sm" type="button" data-activate-admin="${admin.id}">Activate</button>`}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        tbody.querySelectorAll('[data-edit-admin]').forEach((btn) => {
            btn.addEventListener('click', () => this.openEditAdmin(Number(btn.dataset.editAdmin)));
        });
        tbody.querySelectorAll('[data-deactivate-admin]').forEach((btn) => {
            btn.addEventListener('click', () => this.setAdminActive(Number(btn.dataset.deactivateAdmin), false));
        });
        tbody.querySelectorAll('[data-activate-admin]').forEach((btn) => {
            btn.addEventListener('click', () => this.setAdminActive(Number(btn.dataset.activateAdmin), true));
        });
    }

    openEditAdmin(id) {
        const admin = (this.admins || []).find((a) => Number(a.id) === Number(id));
        if (!admin) return;
        this.fillOrgSelects();
        document.getElementById('editAdminId').value = admin.id;
        document.getElementById('editAdminName').value = admin.name;
        document.getElementById('editAdminEmail').value = admin.email;
        document.getElementById('editAdminPassword').value = '';
        const orgSelect = document.getElementById('editAdminOrg');
        if (orgSelect) orgSelect.value = admin.organization_id || '';
        document.getElementById('editAdminModal')?.classList.add('show');
    }

    async saveAdminEdit() {
        const id = Number(document.getElementById('editAdminId')?.value);
        const payload = {
            action: 'update_admin',
            id,
            name: document.getElementById('editAdminName')?.value.trim(),
            email: document.getElementById('editAdminEmail')?.value.trim(),
            organization_id: Number(document.getElementById('editAdminOrg')?.value)
        };
        const password = document.getElementById('editAdminPassword')?.value;
        if (password) payload.password = password;
        if (!payload.name || !payload.email || !payload.organization_id) {
            this.toast('Name, email, and organization are required.', 'warning');
            return;
        }
        try {
            const result = await this.request('super.php', { method: 'PUT', body: JSON.stringify(payload) });
            document.getElementById('editAdminModal')?.classList.remove('show');
            this.toast(result.message || 'Admin updated.', 'success');
            await this.loadAdmins();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async setAdminActive(id, active) {
        const ok = await this.confirmDialog({
            title: active ? 'Activate org admin' : 'Deactivate org admin',
            message: active
                ? 'They will be able to open their organization console again.'
                : 'They will be signed out and cannot track workers until you activate them.',
            confirmText: active ? 'Activate' : 'Deactivate',
            danger: !active
        });
        if (!ok) return;
        try {
            const result = await this.request('super.php', {
                method: 'PUT',
                body: JSON.stringify({ action: 'update_admin', id, is_active: active })
            });
            this.toast(result.message || 'Updated.', 'success');
            await this.loadAdmins();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async createAdmin() {
        const name = document.getElementById('adminName')?.value.trim();
        const email = document.getElementById('adminEmail')?.value.trim();
        const password = document.getElementById('adminPassword')?.value;
        const organizationId = document.getElementById('adminOrg')?.value;
        let valid = true;
        this.clearFieldError('adminName');
        this.clearFieldError('adminEmail');
        this.clearFieldError('adminPassword');
        this.clearFieldError('adminOrg');
        if (!organizationId) { this.setFieldError('adminOrg', 'Select an organization.'); valid = false; }
        if (!name) { this.setFieldError('adminName', 'Name is required.'); valid = false; }
        if (!email) { this.setFieldError('adminEmail', 'Email is required.'); valid = false; }
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.setFieldError('adminEmail', 'Enter a valid email.'); valid = false; }
        if (!password || password.length < 8) { this.setFieldError('adminPassword', 'Use at least 8 characters.'); valid = false; }
        if (!valid) {
            this.toast('Please fix the highlighted fields.', 'warning');
            return;
        }
        const btn = document.getElementById('createAdminBtn');
        this.setButtonLoading(btn, true, 'Creating…');
        try {
            const result = await this.request('super.php', {
                method: 'POST',
                body: JSON.stringify({ action: 'create_admin', name, email, password, organization_id: Number(organizationId) })
            });
            this.toast(result.message || 'Organization admin created.', 'success');
            document.getElementById('adminForm')?.reset();
            await this.loadAdmins();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error', 'Create failed');
        } finally {
            this.setButtonLoading(btn, false);
        }
    }

    async loadSessions(notify = false) {
        try {
            const rows = await this.request('super.php?type=sessions');
            this.displaySessions(Array.isArray(rows) ? rows : []);
            if (notify) this.toast('Sessions updated.', 'success');
        } catch (error) {
            this.toast(error.message, 'error', 'Sessions');
        }
    }

    displaySessions(rows) {
        const tbody = document.querySelector('#sessionsTable tbody');
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="6">${this.emptyState('No active sessions', 'Signed-in users will appear here.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = rows.map((row) => `
            <tr>
                <td>${this.escapeHtml(row.user_name || 'Unknown')}<div class="feed-meta">${this.escapeHtml(row.user_email || '')}</div></td>
                <td>${row.privilege === 'super_admin' ? '<span class="badge badge-super">Geo-Lo owner</span>' : `<span class="badge badge-muted">${this.escapeHtml(row.organization_name || row.role)}</span>`}</td>
                <td>${this.formatWhen(row.last_seen)}</td>
                <td>${this.formatWhen(row.expires_at)}</td>
                <td>${this.escapeHtml((row.device_fingerprint || '—').slice(0, 12))}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-danger btn-sm" type="button" data-revoke="${row.id}">Revoke</button>
                    </div>
                </td>
            </tr>
        `).join('');
        tbody.querySelectorAll('[data-revoke]').forEach((btn) => {
            btn.addEventListener('click', () => this.revokeSession(Number(btn.dataset.revoke)));
        });
    }

    async revokeSession(id) {
        const ok = await this.confirmDialog({
            title: 'Revoke session',
            message: 'This device will be signed out immediately.',
            confirmText: 'Revoke',
            danger: true
        });
        if (!ok) return;
        try {
            const result = await this.request('super.php', {
                method: 'DELETE',
                body: JSON.stringify({ action: 'revoke_session', id })
            });
            this.toast(result.message || 'Session revoked.', 'success');
            await this.loadSessions();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async loadWorkers(notify = false) {
        try {
            const rows = await this.request('super.php?type=workers');
            this.displayWorkers(Array.isArray(rows) ? rows : []);
            if (notify) this.toast('Directory updated.', 'success');
        } catch (error) {
            this.toast(error.message, 'error', 'Directory');
        }
    }

    displayWorkers(rows) {
        const tbody = document.querySelector('#workersTable tbody');
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="7">${this.emptyState('No workers', 'Register workers from the ops console.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = rows.map((w) => {
            const active = Number(w.is_active) === 1;
            return `
                <tr>
                    <td>${this.escapeHtml(w.employee_id)}</td>
                    <td>${this.escapeHtml(w.name)}</td>
                    <td>${this.escapeHtml(w.organization_name || '—')}</td>
                    <td>${this.escapeHtml(w.email)}</td>
                    <td>${this.escapeHtml(w.punch_count || 0)}</td>
                    <td>
                        <span class="badge ${active ? 'badge-ok' : 'badge-off'}">${active ? 'Active' : 'Inactive'}</span>
                        ${Number(w.device_bound) === 1 ? ' <span class="badge badge-muted">Device</span>' : ''}
                        ${Number(w.require_face) === 1 ? ' <span class="badge badge-warn">Face</span>' : ''}
                    </td>
                    <td>
                        <div class="row-actions">
                            ${active
                                ? `<button class="btn btn-danger btn-sm" type="button" data-deactivate-worker="${w.id}">Deactivate</button>`
                                : `<button class="btn btn-success btn-sm" type="button" data-restore-worker="${w.id}">Restore</button>`}
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
        tbody.querySelectorAll('[data-restore-worker]').forEach((btn) => {
            btn.addEventListener('click', () => this.restoreWorker(Number(btn.dataset.restoreWorker)));
        });
        tbody.querySelectorAll('[data-deactivate-worker]').forEach((btn) => {
            btn.addEventListener('click', () => this.deactivateWorker(Number(btn.dataset.deactivateWorker)));
        });
    }

    async restoreWorker(id) {
        try {
            const result = await this.request('super.php', {
                method: 'PUT',
                body: JSON.stringify({ action: 'restore_worker', id })
            });
            this.toast(result.message || 'Worker restored.', 'success');
            await this.loadWorkers();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async deactivateWorker(id) {
        const ok = await this.confirmDialog({
            title: 'Deactivate worker',
            message: 'They will be signed out and hidden from the ops console.',
            confirmText: 'Deactivate',
            danger: true
        });
        if (!ok) return;
        try {
            const result = await this.request('super.php', {
                method: 'PUT',
                body: JSON.stringify({ action: 'deactivate_worker', id })
            });
            this.toast(result.message || 'Worker deactivated.', 'success');
            await this.loadWorkers();
            await this.loadOverview();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async loadSecurity(notify = false) {
        try {
            const data = await this.request('super.php?type=security');
            this.animateCount(document.getElementById('secFailedToday'), data.failed_today);
            this.animateCount(document.getElementById('secFailedWeek'), data.failed_week);
            this.animateCount(document.getElementById('secBound'), data.device_bound_workers);
            this.animateCount(document.getElementById('secFace'), data.face_required_workers);
            const tbody = document.querySelector('#attemptsTable tbody');
            const attempts = data.attempts || [];
            if (!tbody) return;
            if (!attempts.length) {
                tbody.innerHTML = `<tr><td colspan="5">${this.emptyState('No punch attempts', 'Failed clock-ins will appear here.')}</td></tr>`;
                return;
            }
            tbody.innerHTML = attempts.map((a) => `
                <tr>
                    <td>${this.formatWhen(a.created_at)}</td>
                    <td>${this.escapeHtml(a.worker_name || 'Unknown')} <span class="feed-meta">${this.escapeHtml(a.employee_id || '')}</span></td>
                    <td>${this.escapeHtml(a.action || '—')}</td>
                    <td><span class="badge ${Number(a.success) === 1 ? 'badge-ok' : 'badge-off'}">${Number(a.success) === 1 ? 'OK' : 'Blocked'}</span></td>
                    <td>${this.escapeHtml(a.reason || '—')}</td>
                </tr>
            `).join('');
            if (notify) this.toast('Security data updated.', 'success');
        } catch (error) {
            this.toast(error.message, 'error', 'Security');
        }
    }

    async loadAudit() {
        const action = document.getElementById('auditAction')?.value.trim() || '';
        const entity = document.getElementById('auditEntity')?.value || '';
        const params = new URLSearchParams({ type: 'audit' });
        if (action) params.set('action', action);
        if (entity) params.set('entity', entity);
        try {
            const rows = await this.request(`super.php?${params.toString()}`);
            const tbody = document.querySelector('#auditTable tbody');
            if (!tbody) return;
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="6">${this.emptyState('No audit events', 'Try a different filter.')}</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map((r) => `
                <tr>
                    <td>${this.formatWhen(r.created_at)}</td>
                    <td>${this.escapeHtml(this.actorLabel(r))}</td>
                    <td>${this.escapeHtml(r.organization_name || '—')}</td>
                    <td>${this.escapeHtml(r.action)}</td>
                    <td>${this.escapeHtml(r.entity)} ${r.entity_id || ''}</td>
                    <td>${this.escapeHtml(String(r.details || '').slice(0, 140))}</td>
                </tr>
            `).join('');
        } catch (error) {
            this.toast(error.message, 'error', 'Audit');
        }
    }

    async logout() {
        try {
            await fetch(`${this.baseUrl}/auth.php`, {
                method: 'POST',
                headers: GeoSession.headers(),
                credentials: 'include',
                body: JSON.stringify({ action: 'logout' })
            });
        } catch (e) {}
        GeoSession.clear();
        window.location.replace('super-login.html');
    }
}

const superAdmin = new SuperDashboard();
