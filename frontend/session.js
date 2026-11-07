const GeoSession = {
    tokenKey: 'geo_token',
    roleKey: 'geo_role',
    userKey: 'geo_user',

    getToken() { return localStorage.getItem(this.tokenKey); },
    getRole() { return localStorage.getItem(this.roleKey); },
    getUser() {
        try { return JSON.parse(localStorage.getItem(this.userKey) || 'null'); }
        catch (e) { return null; }
    },
    set(token, role, user) {
        localStorage.setItem(this.tokenKey, token);
        localStorage.setItem(this.roleKey, role);
        localStorage.setItem(this.userKey, JSON.stringify(user || {}));
    },
    clear() {
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.roleKey);
        localStorage.removeItem(this.userKey);
        localStorage.removeItem('authWorker');
    },
    loadingCssReady: false,
    injectLoadingCss() {
        if (this.loadingCssReady || typeof document === 'undefined') return;
        this.loadingCssReady = true;
        const style = document.createElement('style');
        style.id = 'geo-btn-loading-style';
        style.textContent = '.geo-btn-loading{position:relative;pointer-events:none;color:transparent!important}.geo-btn-loading>*{visibility:hidden}.geo-btn-loading::after{content:"";position:absolute;top:50%;left:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:geo-btn-spin .6s linear infinite;visibility:visible}@keyframes geo-btn-spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(style);
    },
    setButtonLoading(button, isLoading) {
        if (!button) return;
        this.injectLoadingCss();
        if (isLoading) {
            if (!button.classList.contains('geo-btn-loading')) {
                button.dataset.geoWasDisabled = button.disabled ? '1' : '0';
            }
            button.classList.add('geo-btn-loading');
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
        } else {
            button.classList.remove('geo-btn-loading');
            button.disabled = button.dataset.geoWasDisabled === '1';
            delete button.dataset.geoWasDisabled;
            button.removeAttribute('aria-busy');
        }
    },
    headers() {
        const token = this.getToken();
        const headers = { Accept: 'application/json' };
        if (token) {
            headers.Authorization = 'Bearer ' + token;
            headers['X-Auth-Token'] = token;
        }
        return headers;
    },
    apiRoot() {
        const path = window.location.pathname;
        const marker = '/frontend/';
        const idx = path.indexOf(marker);
        if (idx >= 0) return path.slice(0, idx) + '/api';
        return '/api';
    },
    apiUrl(path) {
        if (String(path || '').startsWith('http')) return path;
        const file = String(path || '').replace(/^\/?(?:Geo-lo\/)?api\//, '').replace(/^\//, '');
        return this.apiRoot() + '/' + file;
    },
    async api(url, options = {}) {
        const headers = Object.assign({}, this.headers(), options.headers || {});
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        return fetch(this.apiUrl(url), Object.assign({}, options, { headers, credentials: 'include' }));
    },
    async assertAdmin() {
        // The PHP page already validated this session, so trust its boot payload to avoid a second round-trip.
        const boot = window.__GEO_BOOT;
        if (boot && boot.role === 'admin' && boot.user && this.getToken()) {
            this.set(this.getToken(), 'admin', Object.assign({}, boot.user, {
                privilege: boot.user.privilege || boot.privilege || 'admin'
            }));
            if (boot.user.privilege === 'super_admin') return true;
            if (!boot.user.organization_id) {
                this.clear();
                return false;
            }
            return true;
        }
        if (this.getRole() === 'worker') {
            this.clear();
            return false;
        }
        try {
            const res = await this.api('auth.php');
            const data = await res.json();
            if (!res.ok || data.role !== 'admin' || !data.user) {
                this.clear();
                return false;
            }
            this.set(this.getToken(), 'admin', Object.assign({}, data.user, {
                privilege: data.user.privilege || data.privilege || 'admin'
            }));
            if (data.user.privilege === 'super_admin') return true;
            if (!data.user.organization_id) {
                this.clear();
                return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    },
    async assertOrgAdmin() {
        const ok = await this.assertAdmin();
        if (!ok) return false;
        const user = this.getUser();
        if (!user || user.privilege === 'super_admin' || !user.organization_id) {
            return false;
        }
        return true;
    },
    async assertSuperAdmin() {
        const ok = await this.assertAdmin();
        if (!ok) return false;
        const user = this.getUser();
        return !!(user && user.privilege === 'super_admin');
    },
    async assertWorker() {
        // The PHP page already validated this session, so trust its boot payload to avoid a second round-trip.
        const boot = window.__GEO_BOOT;
        if (boot && boot.role === 'worker' && boot.user && this.getToken()) {
            this.set(this.getToken(), 'worker', boot.user);
            return true;
        }
        if (this.getRole() === 'admin') {
            return false;
        }
        try {
            const res = await this.api('auth.php');
            const data = await res.json();
            if (!res.ok || data.role !== 'worker' || !data.user) {
                this.clear();
                return false;
            }
            this.set(this.getToken() || '', 'worker', data.user);
            return true;
        } catch (e) {
            this.clear();
            return false;
        }
    },
    async fingerprint() {
        const raw = [navigator.userAgent, screen.width + 'x' + screen.height, (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), navigator.language].join('|');
        if (!window.crypto || !crypto.subtle) {
            return btoa(unescape(encodeURIComponent(raw))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
        }
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
};
