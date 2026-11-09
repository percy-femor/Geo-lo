class AdminError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'AdminError';
        this.status = status;
    }
}

class AdminDashboard {
    constructor() {
        this.baseUrl = GeoSession.apiRoot();
        this.currentEditingId = null;
        this.currentLocation = null;
        this.map = null;
        this.polygonPoints = [];
        this.polygonLayer = null;
        this.polygonMarkers = [];
        this.tileLayer = null;
        this.searchMarker = null;
        this.legacyRadius = null;
        this.confirmResolver = null;
        this.pageCopy = {
            dashboard: ['Dashboard', 'Who is on site, who is late, and today’s exceptions'],
            workers: ['Workers', 'Register and manage employee accounts'],
            locations: ['Locations', 'Define geofenced workplaces for check-in'],
            shifts: ['Shifts', 'Expected hours, lateness, and overtime rules'],
            reports: ['Reports', 'Daily, monthly, and payroll-ready hours'],
            audit: ['Audit', 'Activity inside this organization']
        };
        this.init();
    }

    async init() {
        try {
            const allowed = typeof GeoSession.assertOrgAdmin === 'function'
                ? await GeoSession.assertOrgAdmin()
                : await this.fallbackOrgAdmin();
            if (!allowed) {
                window.location.replace('admin-login.html');
                return;
            }
            document.body.classList.add('admin-ok');
            document.body.classList.remove('admin-pending');
            const user = GeoSession.getUser();
        const brand = document.getElementById('orgBrand');
        if (brand && user && user.organization_name) brand.textContent = user.organization_name;
        const subtitle = document.getElementById('pageSubtitle');
        if (subtitle && user && user.organization_name) {
            this.pageCopy.dashboard[1] = `Who is on site at ${user.organization_name}`;
            subtitle.textContent = this.pageCopy.dashboard[1];
        }
        this.applyStoredTheme();
        this.setupThemeToggle();
        this.setupMobileNav();
        this.setupEventListeners();
        this.setupTabNavigation();
        this.setupConfirmModal();
        this.setupEnhancedLocationGetter();
        this.initializeDateInputs();
        await this.refreshAll();
        this.loadShifts();
        this.loadAlerts();
        this.loadLiveBoard();
        } catch (error) {
            window.location.replace('admin-login.html');
        }
    }

    async fallbackOrgAdmin() {
        const ok = await GeoSession.assertAdmin();
        if (!ok) return false;
        const user = GeoSession.getUser();
        return !!(user && user.privilege !== 'super_admin' && user.organization_id);
    }

    async refreshAll() {
        await Promise.all([
            this.loadDashboardStats(),
            this.loadWorkers(),
            this.loadLocations()
        ]);
    }

    /* ---------- UI chrome ---------- */

    applyStoredTheme() {
        const theme = localStorage.getItem('geo_theme') || 'light';
        document.body.classList.toggle('light', theme === 'light');
    }

    setupThemeToggle() {
        const toggle = document.getElementById('themeToggle');
        if (!toggle) return;
        toggle.addEventListener('click', () => {
            document.body.classList.toggle('light');
            localStorage.setItem('geo_theme', document.body.classList.contains('light') ? 'light' : 'dark');
            this.refreshMapTiles();
        });
    }

    setupMobileNav() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        const toggle = document.getElementById('menuToggle');
        const close = () => {
            sidebar?.classList.remove('open');
            overlay?.classList.remove('show');
        };
        toggle?.addEventListener('click', () => {
            sidebar?.classList.add('open');
            overlay?.classList.add('show');
        });
        overlay?.addEventListener('click', close);
        document.querySelectorAll('.menu-item').forEach((item) => item.addEventListener('click', close));
    }

    setupEventListeners() {
        document.getElementById('workerForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleWorkerSubmit();
        });
        document.getElementById('locationForm')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLocationSubmit();
        });
        document.getElementById('toggleWorkerPassword')?.addEventListener('click', (e) => {
            const input = document.getElementById('workerPassword');
            if (!input) return;
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            e.currentTarget.textContent = show ? '🙈' : '👁️';
        });
        document.getElementById('refreshDashboardBtn')?.addEventListener('click', () => this.loadDashboardStats(true));
        document.getElementById('retryDashboardBtn')?.addEventListener('click', () => this.loadDashboardStats(true));
        document.getElementById('retryWorkersBtn')?.addEventListener('click', () => this.loadWorkers(true));
        document.getElementById('retryLocationsBtn')?.addEventListener('click', () => this.loadLocations(true));
        document.getElementById('dailyReportBtn')?.addEventListener('click', () => this.generateDailyReport());
        document.getElementById('monthlyReportBtn')?.addEventListener('click', () => this.generateMonthlyReport());
        document.getElementById('logoutBtn')?.addEventListener('click', () => this.logout());
        document.getElementById('shiftForm')?.addEventListener('submit', (e) => { e.preventDefault(); this.handleShiftSubmit(); });
        document.getElementById('payrollLoadBtn')?.addEventListener('click', () => this.loadPayroll());
        document.getElementById('payrollCsvBtn')?.addEventListener('click', () => this.exportPayroll('csv'));
        document.getElementById('payrollXlsBtn')?.addEventListener('click', () => this.exportPayroll('xls'));
        document.getElementById('refreshAuditBtn')?.addEventListener('click', () => this.loadAudit());
        document.getElementById('markAlertsReadBtn')?.addEventListener('click', () => this.markAlertsRead());
        document.getElementById('correctCancel')?.addEventListener('click', () => document.getElementById('correctModal')?.classList.remove('show'));
        document.getElementById('correctSave')?.addEventListener('click', () => this.saveCorrection());

        ['employeeId', 'workerName', 'workerEmail', 'workerPin', 'workerPassword', 'locationName', 'locationPolygon', 'workerSelectReport']
            .forEach((id) => {
                document.getElementById(id)?.addEventListener('input', () => this.clearFieldError(id));
                document.getElementById(id)?.addEventListener('change', () => this.clearFieldError(id));
            });
    }

    initializeDateInputs() {
        const monthSelect = document.getElementById('monthSelect');
        const now = new Date();
        if (monthSelect) {
            monthSelect.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }
        const iso = now.toISOString().slice(0, 10);
        const from = document.getElementById('payrollFrom');
        const to = document.getElementById('payrollTo');
        if (from) from.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        if (to) to.value = iso;
    }

    setupTabNavigation() {
        const menuItems = document.querySelectorAll('.menu-item');
        menuItems.forEach((item) => {
            item.addEventListener('click', () => {
                menuItems.forEach((i) => i.classList.remove('active'));
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
                if (tabId === 'locations' && this.map) {
                    setTimeout(() => this.map.invalidateSize(), 280);
                }
                if (tabId === 'audit') this.loadAudit();
                if (tabId === 'shifts') this.loadShifts();
            });
        });
    }

    /* ---------- Toasts & confirm ---------- */

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
        const remove = () => {
            el.classList.add('hide');
            setTimeout(() => el.remove(), 280);
        };
        el.querySelector('.toast-close')?.addEventListener('click', remove);
        stack.appendChild(el);
        setTimeout(remove, type === 'error' ? 7000 : 4200);
    }

    setupConfirmModal() {
        const backdrop = document.getElementById('confirmModal');
        const ok = document.getElementById('confirmOk');
        const cancel = document.getElementById('confirmCancel');
        const finish = (value) => {
            backdrop?.classList.remove('show');
            if (this.confirmResolver) {
                this.confirmResolver(value);
                this.confirmResolver = null;
            }
        };
        ok?.addEventListener('click', () => finish(true));
        cancel?.addEventListener('click', () => finish(false));
        backdrop?.addEventListener('click', (e) => {
            if (e.target === backdrop) finish(false);
        });
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

    /* ---------- Helpers ---------- */

    escapeHtml(value) {
        if (value == null) return '';
        return String(value).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    setBanner(id, show, message) {
        const banner = document.getElementById(id);
        if (!banner) return;
        banner.classList.toggle('show', !!show);
        const text = banner.querySelector('span');
        if (text && message) text.textContent = message;
    }

    setFieldError(id, message) {
        const input = document.getElementById(id);
        const error = document.querySelector(`.field-error[data-for="${id}"]`);
        input?.classList.toggle('is-invalid', !!message);
        if (input && message) {
            input.classList.remove('shake');
            void input.offsetWidth;
            input.classList.add('shake');
        } else {
            input?.classList.remove('shake');
        }
        if (error) {
            error.textContent = message || '';
            error.classList.toggle('show', !!message);
        }
    }

    clearFieldError(id) {
        this.setFieldError(id, '');
    }

    clearFormErrors(ids) {
        ids.forEach((id) => this.clearFieldError(id));
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
        const target = Number(value) || 0;
        const start = Number(el.textContent) || 0;
        if (start === target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            el.textContent = String(target);
            return;
        }
        const duration = 500;
        const startTime = performance.now();
        const tick = (now) => {
            const t = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = String(Math.round(start + (target - start) * eased));
            if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    emptyState(title, message) {
        return `
            <div class="state-box">
                <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                    <circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>
                </svg>
                <h4>${this.escapeHtml(title)}</h4>
                <p>${this.escapeHtml(message)}</p>
            </div>
        `;
    }

    skeletonRows() {
        return `
            <div class="skeleton-row"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
            <div class="skeleton-row"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>
        `;
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
            if (response.status === 401 || response.status === 403) {
                GeoSession.clear();
                window.location.replace('admin-login.html?denied=1');
                throw new AdminError('Session expired. Please sign in again.');
            }
            const data = await this.parseJsonSafe(response);
            if (!response.ok || (data && data.error)) {
                throw new AdminError(data.error || data.message || `Request failed (${response.status})`, response.status);
            }
            return data;
        } catch (error) {
            if (error instanceof AdminError) throw error;
            if (error.name === 'AbortError') throw new AdminError('The request timed out. Please try again.');
            throw new AdminError('Network error. Check your connection and try again.');
        } finally {
            clearTimeout(timeout);
        }
    }

    /* ---------- Workspace polygon capture ---------- */

    setupEnhancedLocationGetter() {
        this.setupLocationButtonListeners();
        this.updatePolygonUI();
    }

    setupLocationButtonListeners() {
        document.getElementById('startAutoLocationBtn')?.addEventListener('click', () => this.addPointAtMyLocation());
        document.getElementById('openMapPickerBtn')?.addEventListener('click', () => this.openMapPicker());
        document.getElementById('undoPolygonBtn')?.addEventListener('click', () => this.undoPolygonPoint());
        document.getElementById('clearPolygonBtn')?.addEventListener('click', () => this.clearPolygon());
        document.getElementById('mapSearchBtn')?.addEventListener('click', () => this.searchMapLocation());
        document.getElementById('mapSearchInput')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.searchMapLocation();
            }
        });
    }

    addPointAtMyLocation() {
        if (!navigator.geolocation) {
            this.showLocationMessage('Geolocation is not supported by this browser.', 'error');
            this.toast('Geolocation is not supported by this browser.', 'error');
            return;
        }
        if (!window.isSecureContext) {
            this.showLocationMessage('Your browser only shares your location on a secure (https://) page. Open this site using its https address, then try again — or use “Pick points on map”.', 'error');
            this.toast('Location needs an https:// connection.', 'error', 'Location');
            return;
        }
        if (!confirm(
            'This will add a point at YOUR CURRENT physical location.\n\n' +
            'Only use this if you are standing at the corner of the workplace right now.\n\n' +
            'To place a point somewhere else, cancel and click the map instead.'
        )) return;

        const last = this.polygonPoints[this.polygonPoints.length - 1];
        this.showLocationMessage('Getting a precise GPS fix… stay still for a moment.', 'info');
        this.updateAutoLocationStatus('Getting a precise fix…', 'active');
        this.capturePrecisePosition(last, (live) => {
            // Only update the status text here — never commit this.currentLocation from a
            // progress event, or a rough early fix can be shown as the captured position.
            this.updateAutoLocationStatus(`Getting a precise fix… ±${Math.round(live.accuracy)} m`, 'active');
        }).then((fix) => {
            this.currentLocation = { latitude: fix.lat, longitude: fix.lng, accuracy: fix.accuracy };
            this.updateAccuracyDisplay();
            const accuracy = Number(fix.accuracy);
            // A fix with accuracy worse than ~30 m is usually Wi-Fi/network, not GPS, and can be
            // hundreds of metres out. Refuse to save a wrong corner.
            if (Number.isFinite(accuracy) && accuracy > 30) {
                this.updateAutoLocationStatus(`Rough fix (±${Math.round(accuracy)} m)`, 'inactive');
                this.showLocationMessage(
                    `Your device is only locating you to ±${Math.round(accuracy)} m — likely Wi-Fi or approximate location.\n\n` +
                    `To fix this:\n` +
                    `• In Chrome: click the padlock → Site settings → Location → set to "Precise"\n` +
                    `• Move outside for better GPS signal\n` +
                    `• Or click on the map to place the point manually`,
                    'error',
                    { retry: true }
                );
                return;
            }
            if (last && this.calculateDistance(last.lat, last.lng, fix.lat, fix.lng) < 5) {
                this.updateAutoLocationStatus('Location not changing', 'inactive');
                this.showLocationMessage(this.sameLocationMessage(), 'error');
                return;
            }
            // Devices without real GPS (laptops, or phones using a network fix) can report a
            // confident-looking position that is a whole town away. Catch that here.
            if (last && this.calculateDistance(last.lat, last.lng, fix.lat, fix.lng) > 5000) {
                this.updateAutoLocationStatus('Fix looks wrong', 'inactive');
                this.showLocationMessage(
                    'That position is more than 5 km from your last corner — likely an approximate fix.\n' +
                    'Move into the open with GPS on, or use the map to place the point.',
                    'error'
                );
                return;
            }
            if (this.addPolygonPoint(fix.lat, fix.lng)) {
                this.updateAutoLocationStatus('Point added', 'active');
                this.showLocationMessage(
                    `Point ${this.polygonPoints.length} added from your current position (±${Math.round(accuracy)} m).`,
                    'success'
                );
            }
        }).catch((error) => this.handleLocationError(error));
    }

    // iOS Safari returns a cached, unchanging position from repeated getCurrentPosition()
    // calls; watchPosition() streams fresh fixes. We resolve with the first precise fix that
    // actually moved from the previous point and held steady, and otherwise only fall back to
    // the best fix if it is still reasonably accurate. A low "accuracy" number does not mean
    // the position is right: Wi-Fi fixes often report 30–60 m while being hundreds of metres out.
    capturePrecisePosition(previous, onProgress) {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                return reject({ code: 2, reason: 'unsupported' });
            }

            const options = { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 };
            const settleAfter = previous ? 12000 : 8000;
            const hardTimeout = 25000;
            const PRECISE_THRESHOLD = 20;
            const FALLBACK_THRESHOLD = 40;
            const JITTER_MIN = 1.5;

            let watchId = null;
            let settleTimer = null;
            let hardTimer = null;
            let best = null;
            let stableCount = 0;
            let lastGood = null;
            let settled = false;
            const fixes = [];

            const cleanup = () => {
                if (watchId !== null) navigator.geolocation.clearWatch(watchId);
                watchId = null;
                clearTimeout(settleTimer);
                clearTimeout(hardTimer);
            };

            const finish = (result, isError) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (isError) reject(result); else resolve(result);
            };

            // Real GPS jitters by a few metres even when standing perfectly still. A snapped
            // or coarse (network) position stays frozen. If we never see that natural movement,
            // the fix is almost certainly not a real GPS fix — reject it.
            const spread = () => {
                if (fixes.length < 2) return 0;
                let max = 0;
                for (let i = 0; i < fixes.length; i++) {
                    for (let j = i + 1; j < fixes.length; j++) {
                        const d = this.calculateDistance(
                            fixes[i].lat, fixes[i].lng, fixes[j].lat, fixes[j].lng
                        );
                        if (d > max) max = d;
                    }
                }
                return max;
            };

            const giveBest = () => {
                if (best && best.accuracy <= FALLBACK_THRESHOLD && spread() >= JITTER_MIN) {
                    finish(best);
                } else {
                    const reason = spread() < JITTER_MIN ? 'static_position' : 'no_precise_fix';
                    finish(
                        { code: 3, reason, accuracy: best?.accuracy ?? 9999 },
                        true
                    );
                }
            };

            settleTimer = setTimeout(giveBest, settleAfter);
            hardTimer = setTimeout(giveBest, hardTimeout);

            watchId = navigator.geolocation.watchPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lng = position.coords.longitude;
                    const accuracy = position.coords.accuracy || 9999;
                    const fix = { lat, lng, accuracy };

                    fixes.push(fix);
                    if (fixes.length > 20) fixes.shift();

                    if (onProgress) onProgress(fix);

                    if (!best || accuracy < best.accuracy) best = fix;

                    // Stability check: two consecutive similar fixes
                    if (lastGood && this.calculateDistance(lastGood.lat, lastGood.lng, lat, lng) < 3) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                    }
                    lastGood = fix;

                    const moved = !previous || this.calculateDistance(previous.lat, previous.lng, lat, lng) >= 2;
                    // Require: good accuracy, moved from the previous corner, AND the position has
                    // shown natural GPS jitter (spread) — proves this is a real fix, not a frozen
                    // coarse/snapped location.
                    if (moved && accuracy <= PRECISE_THRESHOLD && stableCount >= 1 && spread() >= JITTER_MIN) {
                        finish(fix);
                    }
                },
                (error) => finish(error, true),
                options
            );
        });
    }

    sameLocationMessage() {
        if (this.isIOS()) {
            return 'Your iPhone is reporting the same position for every point. This usually means Precise Location is switched off for Safari. Turn it on: Settings → Privacy & Security → Location Services → Safari Websites → enable Precise Location (or in Safari tap the “aA” button → Website Settings → Precise Location → On). Then walk to the next corner and try again — or use “Pick points on map”.';
        }
        return 'Your device reported the same location as the previous point. Devices without GPS return one fixed approximate location. Use “Pick points on map” to click each corner of the workspace.';
    }

    async handleLocationError(error) {
        this.updateAutoLocationStatus('Location capture failed', 'inactive');

        if (error?.code === 3 && error?.reason === 'static_position') {
            const ios = this.isIOS();
            this.showLocationMessage('', 'error', {
                html:
                    `<strong>Your device is returning a frozen position</strong><br>` +
                    `The GPS coordinates are not changing, which means your browser is using a ` +
                    `coarse/approximate location instead of real GPS. This is almost always ` +
                    (ios
                        ? `because <b>Precise Location is off for Safari</b>.<br><br>` +
                          `<b>To fix it:</b><br>` +
                          `1. Open the iPhone Settings app<br>` +
                          `2. Privacy &amp; Security → Location Services → Safari Websites<br>` +
                          `3. Turn on <b>Precise Location</b><br>` +
                          `4. Come back and reload this page<br><br>` +
                          `Or use “Pick points on map” to click the corners yourself.`
                        : `because GPS isn't getting a real fix.<br><br>` +
                          `<b>Try:</b><br>` +
                          `• Move outside or near a window (GPS needs sky)<br>` +
                          `• In Chrome: click the padlock → Site settings → Location → set to Precise<br>` +
                          `• Or use “Pick points on map” to click the corners yourself.<br><br>`) +
                    `<button type="button" class="btn btn-primary btn-sm" data-location-retry style="margin-top:10px">Try again</button> ` +
                    `<button type="button" class="btn btn-ghost btn-sm" data-location-openmap style="margin-top:10px">Use map instead</button>`,
                retry: true
            });
            document.querySelector('[data-location-openmap]')
                ?.addEventListener('click', () => this.openMapPicker());
            return;
        }

        if (error?.code === 3 && error?.reason === 'no_precise_fix') {
            const reported = error.accuracy && error.accuracy < 9999
                ? Math.round(error.accuracy)
                : 'unknown';
            this.showLocationMessage('', 'error', {
                html:
                    `<strong>Could not get a precise GPS fix</strong><br>` +
                    `Your device is only locating you to ±${reported} m.<br><br>` +
                    `Common causes:<br>` +
                    `• <b>Precise Location is off</b> — in Chrome: click the padlock → Site settings → Location → set to Precise<br>` +
                    `• <b>You are indoors</b> — GPS works poorly through concrete; move near a window or outside<br>` +
                    `• <b>No GPS hardware</b> (laptop/desktop) — use "Pick points on map" instead<br><br>` +
                    `<button type="button" class="btn btn-primary btn-sm" data-location-retry style="margin-top:10px">Try again</button> ` +
                    `<button type="button" class="btn btn-ghost btn-sm" data-location-openmap style="margin-top:10px">Use map instead</button>`,
                retry: true
            });
            document.querySelector('[data-location-openmap]')
                ?.addEventListener('click', () => this.openMapPicker());
            return;
        }

        const help = await this.describeLocationProblem(error);
        const primary = help.denied
            ? '<button type="button" class="btn btn-primary btn-sm" data-location-reload style="margin-top:10px">I changed it — reload</button>' +
              ' <button type="button" class="btn btn-ghost btn-sm" data-location-retry style="margin-top:10px">Try again</button>'
            : '<button type="button" class="btn btn-primary btn-sm" data-location-retry style="margin-top:10px">Try again</button>';
        this.showLocationMessage('', 'error', {
            html: `<strong>${this.escapeHtml(help.title)}</strong><br>${this.escapeHtml(help.detail)}<br>` + primary,
            retry: true
        });
        this.toast(help.title, 'error', 'Location failed');
    }

    isIOS() {
        return /iP(hone|ad|od)/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    }

    async describeLocationProblem(error) {
        const code = error && typeof error.code === 'number' ? error.code : 0;
        if (!window.isSecureContext) {
            return {
                title: 'Location needs a secure (https://) page',
                detail: 'Browsers only share your position over https://. Open this site using its https address, then tap Try again — or use “Pick points on map”.'
            };
        }
        let permission = '';
        try {
            if (navigator.permissions && navigator.permissions.query) {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                permission = status.state;
            }
        } catch (e) { /* permissions API not supported */ }
        if (code === 1 || permission === 'denied') {
            const ios = this.isIOS();
            return {
                title: 'Location is blocked for this site',
                denied: true,
                detail: ios
                    ? 'In Safari tap the “aA” button next to the address bar → Website Settings → set Location to Allow, then reload this page. If Location is not listed there, open the iPhone Settings app → Safari → Location and set it to Ask or Allow, then come back and reload. Also check Settings → Privacy & Security → Location Services is on.'
                    : 'Your browser has location switched off for this site, so it will not ask again on its own. In Chrome/Edge tap the padlock (or tune) icon in the address bar → Permissions (or Site settings) → Location → Allow, then reload this page.'
            };
        }
        if (code === 2) {
            return {
                title: 'Location unavailable',
                detail: 'Turn on GPS / Location services on your phone and move near a window or outside, then tap Try again.'
            };
        }
        if (code === 3) {
            return {
                title: 'Location timed out',
                detail: 'GPS took too long to respond. Move somewhere with a clearer signal and tap Try again — or use “Pick points on map”.'
            };
        }
        return {
            title: 'Unable to get your location',
            detail: 'Tap Try again, or use “Pick points on map” to trace the boundary.'
        };
    }

    updateAutoLocationStatus(message, status) {
        const statusElement = document.getElementById('autoLocationStatus');
        const indicator = document.getElementById('locationStatusIndicator');
        const statusText = document.getElementById('locationStatusText');
        if (statusElement) statusElement.textContent = message;
        if (indicator) {
            indicator.className = `status-indicator ${status === 'active' ? 'status-active' : 'status-inactive'}`;
        }
        if (statusText) {
            statusText.textContent = status === 'active' ? 'Location active' : 'Location idle';
        }
    }

    setFormCoordinates(lat, lng) {
        const latInput = document.getElementById('locationLat');
        const lngInput = document.getElementById('locationLng');
        if (latInput) latInput.value = Number(lat).toFixed(6);
        if (lngInput) lngInput.value = Number(lng).toFixed(6);
    }

    updateCoordinatesDisplay() {
        const display = document.getElementById('coordinatesDisplay');
        if (display && this.currentLocation) {
            display.textContent = `Lat ${this.currentLocation.latitude.toFixed(6)}, Lng ${this.currentLocation.longitude.toFixed(6)}`;
        }
    }

    updateAccuracyDisplay() {
        if (!this.currentLocation?.accuracy) return;
        const accuracyText = `Accuracy ±${Math.round(this.currentLocation.accuracy)} m`;
        const accuracyInfo = document.getElementById('accuracyInfo');
        const coordinatesAccuracy = document.getElementById('coordinatesAccuracy');
        const currentAccuracy = document.getElementById('currentAccuracy');
        if (accuracyInfo) accuracyInfo.textContent = accuracyText;
        if (coordinatesAccuracy) coordinatesAccuracy.textContent = accuracyText;
        if (currentAccuracy) currentAccuracy.textContent = `${Math.round(this.currentLocation.accuracy)}m`;
    }

    enableLocationSubmit(label) {
        const submitBtn = document.getElementById('submitLocationBtn');
        if (!submitBtn) return;
        submitBtn.disabled = false;
        submitBtn.textContent = label || (this.currentEditingId ? 'Update location' : 'Add location');
        delete submitBtn.dataset.originalHtml;
    }

    refreshMapTiles() {
        if (!this.map) return;
        if (this.tileLayer) this.map.removeLayer(this.tileLayer);
        // Satellite imagery (same approach as the farm app) so the administrator can see the
        // real ground while tracing the workspace. A street map makes it impossible to tell
        // whether a captured GPS point actually sits where the person is standing.
        this.tileLayer = L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxZoom: 19 }
        ).addTo(this.map);
    }

    ensureMap() {
        const mapContainer = document.getElementById('mapContainer');
        mapContainer?.classList.add('open');

        if (!this.map) {
            this.map = L.map('mapContainer').setView([40.7128, -74.0060], 13);
            this.refreshMapTiles();
            this.map.on('click', (e) => {
                if (this.addPolygonPoint(e.latlng.lat, e.latlng.lng)) {
                    this.showLocationMessage(`Point ${this.polygonPoints.length} added. Keep clicking to trace the workspace boundary.`, 'success');
                }
            });
            const search = document.getElementById('mapSearch');
            if (search) {
                L.DomEvent.disableClickPropagation(search);
                L.DomEvent.disableScrollPropagation(search);
            }
        }

        setTimeout(() => this.map.invalidateSize(), 320);
        return this.map;
    }

    openMapPicker() {
        this.ensureMap();
        this.renderPolygon();
        const points = this.polygonPoints;
        if (points.length) {
            this.map.fitBounds(points.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 18 });
        } else if (this.currentLocation) {
            this.map.setView([this.currentLocation.latitude, this.currentLocation.longitude], 16);
        }
    }

    isValidLatLng(lat, lng) {
        return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    extractCoordinates(text) {
        const patterns = [
            /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
            /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
            /[?&](?:q|ll|query|center|daddr|destination)=(?:loc:)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i,
            /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const lat = Number(match[1]);
                const lng = Number(match[2]);
                if (this.isValidLatLng(lat, lng)) return { lat, lng };
            }
        }
        return null;
    }

    async geocodePlace(query) {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Geocoding failed');
        const results = await response.json();
        if (!Array.isArray(results) || !results.length) return null;
        const first = results[0];
        const lat = Number(first.lat);
        const lng = Number(first.lon);
        if (!this.isValidLatLng(lat, lng)) return null;
        let bounds = null;
        if (Array.isArray(first.boundingbox) && first.boundingbox.length === 4) {
            const [south, north, west, east] = first.boundingbox.map(Number);
            if ([south, north, west, east].every(Number.isFinite)) {
                bounds = [[south, west], [north, east]];
            }
        }
        return { lat, lng, label: first.display_name || query, bounds };
    }

    focusMapOn(lat, lng, zoom = 17, bounds = null) {
        const map = this.ensureMap();
        if (bounds) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
        } else {
            map.setView([lat, lng], zoom);
        }
        if (this.searchMarker) {
            map.removeLayer(this.searchMarker);
            this.searchMarker = null;
        }
        this.searchMarker = L.marker([lat, lng]).addTo(map).bindPopup('Searched location');
    }

    async searchMapLocation() {
        const input = document.getElementById('mapSearchInput');
        const query = (input?.value || '').trim();
        if (!query) {
            this.showLocationMessage('Type a place name or paste a Google Maps link to move the map.', 'info');
            return;
        }

        const coords = this.extractCoordinates(query);
        if (coords) {
            this.focusMapOn(coords.lat, coords.lng);
            this.showLocationMessage(`Map moved to ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}. Click the corners to trace the boundary.`, 'success');
            return;
        }

        this.showLocationMessage('Searching for that place…', 'info');
        try {
            const result = await this.geocodePlace(query);
            if (!result) {
                this.showLocationMessage('No matching place found. Try a more specific name, or paste coordinates from Google Maps.', 'error');
                return;
            }
            this.focusMapOn(result.lat, result.lng, 17, result.bounds);
            this.showLocationMessage(`Map moved to ${result.label}. Click the corners to trace the boundary.`, 'success');
        } catch (error) {
            this.showLocationMessage('Could not search right now. Check your connection, or paste a Google Maps link instead.', 'error');
        }
    }

    addPolygonPoint(lat, lng) {
        const point = { lat: Number(lat), lng: Number(lng) };
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
            this.showLocationMessage('That point could not be read. Try again.', 'error');
            return false;
        }
        this.polygonPoints.push(point);
        this.syncCenter();
        this.renderPolygon();
        this.updatePolygonUI();
        this.clearFieldError('locationPolygon');
        if (this.map) {
            this.map.setView([point.lat, point.lng], Math.max(this.map.getZoom(), 17));
        }
        return true;
    }

    undoPolygonPoint() {
        if (!this.polygonPoints.length) {
            this.showLocationMessage('There are no points to undo.', 'info');
            return;
        }
        this.polygonPoints.pop();
        this.syncCenter();
        this.renderPolygon();
        this.updatePolygonUI();
        this.showLocationMessage('Last point removed.', 'info');
    }

    clearPolygon() {
        this.polygonPoints = [];
        this.currentLocation = null;
        this.legacyRadius = null;
        this.syncCenter();
        this.renderPolygon();
        this.updatePolygonUI();
        this.setFormCoordinates('', '');
        document.getElementById('polygonPointsList') && (document.getElementById('polygonPointsList').innerHTML = '');
        const display = document.getElementById('coordinatesDisplay');
        if (display) display.textContent = 'Not captured yet';
        this.showLocationMessage('Polygon cleared. Start adding points again.', 'info');
    }

    setPolygonPoints(points) {
        this.polygonPoints = (Array.isArray(points) ? points : [])
            .filter((p) => p && p.lat !== undefined && p.lng !== undefined)
            .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
        this.syncCenter();
        this.renderPolygon();
        this.updatePolygonUI();
    }

    syncCenter() {
        if (!this.polygonPoints.length) {
            this.setFormCoordinates('', '');
            return null;
        }
        const sum = this.polygonPoints.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
        const center = { latitude: sum.lat / this.polygonPoints.length, longitude: sum.lng / this.polygonPoints.length };
        this.currentLocation = { ...center, accuracy: this.currentLocation?.accuracy ?? null };
        this.setFormCoordinates(center.latitude, center.longitude);
        this.updateCoordinatesDisplay();
        return center;
    }

    renderPolygon() {
        if (!this.map) return;
        if (this.polygonLayer) { this.map.removeLayer(this.polygonLayer); this.polygonLayer = null; }
        this.polygonMarkers.forEach((m) => this.map.removeLayer(m));
        this.polygonMarkers = [];

        const latlngs = this.polygonPoints.map((p) => [p.lat, p.lng]);
        if (latlngs.length >= 3) {
            this.polygonLayer = L.polygon(latlngs, {
                color: '#6366f1',
                fillColor: '#6366f1',
                fillOpacity: 0.2,
                weight: 2
            }).addTo(this.map);
        } else if (latlngs.length === 2) {
            this.polygonLayer = L.polyline(latlngs, { color: '#6366f1', weight: 2, dashArray: '6 6' }).addTo(this.map);
        }

        this.polygonPoints.forEach((p, index) => {
            const marker = L.circleMarker([p.lat, p.lng], {
                radius: 8,
                color: '#ffffff',
                weight: 2,
                fillColor: '#6366f1',
                fillOpacity: 1
            }).addTo(this.map).bindTooltip(`Point ${index + 1}`, { direction: 'top' });
            this.polygonMarkers.push(marker);
        });
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    polygonAreaSquareMeters(points) {
        if (!Array.isArray(points) || points.length < 3) return 0;
        const rad = Math.PI / 180;
        const earth = 6371000;
        let latSum = 0;
        points.forEach((p) => { latSum += p.lat; });
        const cos = Math.cos((latSum / points.length) * rad);
        const xy = points.map((p) => ({ x: p.lng * rad * cos * earth, y: p.lat * rad * earth }));
        let area = 0;
        for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
            area += (xy[j].x * xy[i].y) - (xy[i].x * xy[j].y);
        }
        return Math.abs(area) / 2;
    }

    updatePolygonUI() {
        const count = this.polygonPoints.length;
        const area = this.polygonAreaSquareMeters(this.polygonPoints);
        const areaValid = area >= 1;
        const countEl = document.getElementById('polygonPointCount');
        const listEl = document.getElementById('polygonPointsList');
        const summaryEl = document.getElementById('locationPolygonSummary');
        const submitBtn = document.getElementById('submitLocationBtn');

        if (countEl) {
            countEl.textContent = count === 0
                ? 'No points yet — add at least 4 to form the workspace area.'
                : `${count} point${count === 1 ? '' : 's'} captured${count < 4 ? ` — add ${4 - count} more (minimum 4).` : ''}` +
                    (count >= 4 && !areaValid ? ' — points overlap, spread them out.' : (count >= 4 ? ' — polygon ready.' : ''));
        }
        if (listEl) {
            listEl.innerHTML = this.polygonPoints.map((p, i) =>
                `<li${i === count - 1 ? ' class="is-next"' : ''}>Point ${i + 1}: ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</li>`
            ).join('');
        }
        if (summaryEl) {
            if (count < 4) {
                summaryEl.textContent = `Add at least 4 points to define the workspace boundary (${count}/4 added).`;
            } else if (!areaValid) {
                summaryEl.textContent = 'These points overlap and enclose no area. Move to the actual corners of the workspace.';
            } else {
                summaryEl.textContent = `Workspace defined by ${count} points (~${Math.round(area).toLocaleString()} m²).`;
            }
        }
        if (submitBtn) {
            const canSubmit = count >= 4 && areaValid;
            if (canSubmit) {
                this.enableLocationSubmit();
            } else if (this.currentEditingId && this.legacyRadius && count === 0) {
                this.enableLocationSubmit();
            } else {
                submitBtn.disabled = true;
                submitBtn.textContent = this.currentEditingId ? 'Update location (capture 4+ points)' : 'Add location (capture 4+ points)';
            }
        }
    }

    showLocationMessage(message, type, options = {}) {
        const el = document.getElementById('locationMessage');
        if (!el) return;
        if (options.html) {
            el.innerHTML = options.html;
        } else {
            el.textContent = message;
        }
        el.className = `location-message show ${type}`;
        if (options.retry) {
            el.querySelector('[data-location-retry]')?.addEventListener('click', () => this.addPointAtMyLocation());
            el.querySelector('[data-location-reload]')?.addEventListener('click', () => window.location.reload());
        }
        if (type === 'success' && !options.html) {
            setTimeout(() => {
                if (el.textContent === message) el.classList.remove('show');
            }, 5000);
        }
    }

    /* ---------- Dashboard ---------- */

    async loadDashboardStats(notify = false) {
        const activity = document.getElementById('todayActivity');
        this.setBanner('dashboardError', false);
        if (activity && !activity.querySelector('table')) activity.innerHTML = this.skeletonRows();

        try {
            const [workers, attendance, locations, live] = await Promise.all([
                this.request('workers.php'),
                this.request('reports.php?type=daily'),
                this.request('locations.php'),
                this.request('reports.php?type=live')
            ]);
            this.animateCount(document.getElementById('totalWorkers'), Array.isArray(workers) ? workers.length : 0);
            this.animateCount(document.getElementById('checkedInToday'), Array.isArray(attendance) ? attendance.length : 0);
            this.animateCount(document.getElementById('totalLocations'), Array.isArray(locations) ? locations.length : 0);
            this.animateCount(document.getElementById('onSiteNow'), live?.counts?.on_site || 0);
            this.renderLiveBoard(live);
            this.displayTodayActivity(Array.isArray(attendance) ? attendance : []);
            if (notify) this.toast('Dashboard updated.', 'success');
        } catch (error) {
            this.setBanner('dashboardError', true, error.message);
            if (activity) {
                activity.innerHTML = this.emptyState('Could not load activity', error.message);
            }
            this.toast(error.message, 'error', 'Dashboard');
        }
    }

    displayTodayActivity(attendance) {
        const container = document.getElementById('todayActivity');
        if (!container) return;
        if (!attendance.length) {
            container.innerHTML = this.emptyState('No activity yet', 'Check-ins from today will appear here.');
            return;
        }
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr><th>Name</th><th>Check in</th><th>Check out</th><th>Status</th><th>Location</th><th></th></tr>
                    </thead>
                    <tbody>
                        ${attendance.map((record) => `
                            <tr>
                                <td>${this.escapeHtml(record.name)}</td>
                                <td>${this.formatTime(record.check_in)}</td>
                                <td>${record.check_out ? this.formatTime(record.check_out) : '—'}</td>
                                <td>${this.statusBadge(record)}</td>
                                <td>${this.escapeHtml(record.location_name)}</td>
                                <td><button class="btn btn-ghost btn-sm" type="button" data-correct="${record.id}" data-in="${this.escapeHtml(record.check_in)}" data-out="${this.escapeHtml(record.check_out || '')}">Correct</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        container.querySelectorAll('[data-correct]').forEach((btn) => {
            btn.addEventListener('click', () => this.openCorrectModal(btn.dataset.correct, btn.dataset.in, btn.dataset.out));
        });
    }

    formatTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? this.escapeHtml(value) : date.toLocaleTimeString();
    }

    formatDate(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? this.escapeHtml(value) : date.toLocaleDateString();
    }

    /* ---------- Workers ---------- */

    async loadWorkers(notify = false) {
        this.setBanner('workersError', false);
        try {
            const workers = await this.request('workers.php');
            const list = Array.isArray(workers) ? workers : [];
            this.displayWorkers(list);
            this.populateWorkerSelect(list);
            if (notify) this.toast('Workers list updated.', 'success');
        } catch (error) {
            this.setBanner('workersError', true, error.message);
            this.displayWorkers([]);
            this.populateWorkerSelect([]);
            this.toast(error.message, 'error', 'Workers');
        }
    }

    displayWorkers(workers) {
        const tbody = document.querySelector('#workersTable tbody');
        if (!tbody) return;
        if (!workers.length) {
            tbody.innerHTML = `<tr><td colspan="6">${this.emptyState('No workers yet', 'Register a worker to get started.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = workers.map((worker) => `
            <tr>
                <td>${this.escapeHtml(worker.employee_id)}</td>
                <td>${this.escapeHtml(worker.name)}</td>
                <td>${this.escapeHtml(worker.email)}</td>
                <td>${this.escapeHtml(worker.phone || 'N/A')}</td>
                <td>${this.escapeHtml(worker.shift_name || '—')}</td>
                <td>
                    <div class="row-actions">
                        <button class="btn btn-ghost btn-sm" type="button" data-reset-device="${worker.id}">Reset device</button>
                        <button class="btn btn-danger btn-sm" type="button" data-delete-worker="${worker.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');
        tbody.querySelectorAll('[data-delete-worker]').forEach((btn) => {
            btn.addEventListener('click', () => this.deleteWorker(Number(btn.dataset.deleteWorker)));
        });
        tbody.querySelectorAll('[data-reset-device]').forEach((btn) => {
            btn.addEventListener('click', () => this.resetDevice(Number(btn.dataset.resetDevice)));
        });
    }

    populateWorkerSelect(workers) {
        const select = document.getElementById('workerSelectReport');
        if (!select) return;
        if (!workers.length) {
            select.innerHTML = '<option value="">No workers available</option>';
            return;
        }
        select.innerHTML = '<option value="">Select a worker</option>' + workers.map((worker) =>
            `<option value="${this.escapeHtml(worker.id)}">${this.escapeHtml(worker.name)} (${this.escapeHtml(worker.employee_id)})</option>`
        ).join('');
    }

    validateWorkerForm() {
        const employeeId = document.getElementById('employeeId')?.value.trim();
        const name = document.getElementById('workerName')?.value.trim();
        const email = document.getElementById('workerEmail')?.value.trim();
        const pin = document.getElementById('workerPin')?.value.trim();
        const password = document.getElementById('workerPassword')?.value;
        const phone = document.getElementById('workerPhone')?.value.trim();
        const shiftId = document.getElementById('workerShift')?.value || null;
        const requireFace = document.getElementById('workerRequireFace')?.checked;
        let valid = true;

        this.clearFormErrors(['employeeId', 'workerName', 'workerEmail', 'workerPin', 'workerPassword']);

        if (!employeeId) { this.setFieldError('employeeId', 'Employee ID is required.'); valid = false; }
        if (!name) { this.setFieldError('workerName', 'Full name is required.'); valid = false; }
        if (!email) {
            this.setFieldError('workerEmail', 'Email is required.');
            valid = false;
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            this.setFieldError('workerEmail', 'Enter a valid email address.');
            valid = false;
        }
        if (!pin) {
            this.setFieldError('workerPin', 'PIN is required.');
            valid = false;
        } else if (!/^\d{4,8}$/.test(pin)) {
            this.setFieldError('workerPin', 'PIN should be 4–8 digits.');
            valid = false;
        }
        if (!password) {
            this.setFieldError('workerPassword', 'Password is required.');
            valid = false;
        } else if (password.length < 6) {
            this.setFieldError('workerPassword', 'Use at least 6 characters.');
            valid = false;
        }

        return valid ? { employee_id: employeeId, name, email, pin, password, phone, shift_id: shiftId, require_face: requireFace } : null;
    }

    async handleWorkerSubmit() {
        const formData = this.validateWorkerForm();
        if (!formData) {
            this.toast('Please fix the highlighted fields.', 'warning', 'Incomplete form');
            return;
        }

        const btn = document.getElementById('registerWorkerBtn');
        this.setButtonLoading(btn, true, 'Registering…');
        try {
            const result = await this.request('workers.php', {
                method: 'POST',
                body: JSON.stringify(formData)
            });
            this.toast(result.message || 'Worker registered successfully.', 'success');
            document.getElementById('workerForm')?.reset();
            this.clearFormErrors(['employeeId', 'workerName', 'workerEmail', 'workerPin', 'workerPassword']);
            await this.loadWorkers();
            await this.loadDashboardStats();
        } catch (error) {
            this.toast(error.message, 'error', 'Registration failed');
        } finally {
            this.setButtonLoading(btn, false);
        }
    }

    async deleteWorker(workerId) {
        const ok = await this.confirmDialog({
            title: 'Delete worker',
            message: 'This removes the worker from the active list. This cannot be undone.',
            confirmText: 'Delete worker',
            danger: true
        });
        if (!ok) return;

        try {
            const result = await this.request('workers.php', {
                method: 'DELETE',
                body: JSON.stringify({ id: workerId })
            });
            this.toast(result.message || 'Worker deleted.', 'success');
            await this.loadWorkers();
            await this.loadDashboardStats();
        } catch (error) {
            this.toast(error.message, 'error', 'Delete failed');
        }
    }

    /* ---------- Locations ---------- */

    async loadLocations(notify = false) {
        this.setBanner('locationsError', false);
        try {
            const locations = await this.request('locations.php');
            this.displayLocations(Array.isArray(locations) ? locations : []);
            if (notify) this.toast('Locations updated.', 'success');
        } catch (error) {
            this.setBanner('locationsError', true, error.message);
            this.displayLocations([]);
            this.toast(error.message, 'error', 'Locations');
        }
    }

    displayLocations(locations) {
        const tbody = document.querySelector('#locationsTable tbody');
        if (!tbody) return;
        if (!locations.length) {
            tbody.innerHTML = `<tr><td colspan="5">${this.emptyState('No locations yet', 'Add a workplace geofence to begin.')}</td></tr>`;
            return;
        }
        tbody.innerHTML = locations.map((location) => {
            const isDefault = Number(location.is_default) === 1 || location.is_default === true;
            const isActive = Number(location.is_active) === 1 || location.is_active === true;
            const points = Array.isArray(location.polygon) ? location.polygon.length : 0;
            const geofence = points >= 3
                ? `<span class="badge badge-ok">Polygon · ${points} points</span>`
                : `Radius · ${this.escapeHtml(location.radius_meters)}m`;
            return `
                <tr>
                    <td>
                        ${this.escapeHtml(location.name)}
                        ${isDefault ? ' <span class="badge badge-muted">Default</span>' : ''}
                    </td>
                    <td>${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}</td>
                    <td>${geofence}</td>
                    <td><span class="badge ${isActive ? 'badge-ok' : 'badge-off'}">${isActive ? 'Active' : 'Inactive'}</span></td>
                    <td>
                        <div class="row-actions">
                            <button class="btn btn-primary btn-sm" type="button" data-edit-location="${location.id}">Edit</button>
                            <button class="btn btn-danger btn-sm" type="button" data-delete-location="${location.id}" ${isDefault ? 'disabled' : ''}>Delete</button>
                            <button class="btn btn-success btn-sm" type="button" data-default-location="${location.id}" ${isDefault ? 'disabled' : ''}>Set default</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-edit-location]').forEach((btn) => {
            btn.addEventListener('click', () => this.editLocation(Number(btn.dataset.editLocation)));
        });
        tbody.querySelectorAll('[data-delete-location]').forEach((btn) => {
            btn.addEventListener('click', () => this.deleteLocation(Number(btn.dataset.deleteLocation)));
        });
        tbody.querySelectorAll('[data-default-location]').forEach((btn) => {
            btn.addEventListener('click', () => this.setDefaultLocation(Number(btn.dataset.defaultLocation)));
        });
    }

    validateLocationForm() {
        const name = document.getElementById('locationName')?.value.trim();
        let valid = true;

        this.clearFormErrors(['locationName', 'locationPolygon']);

        if (!name) { this.setFieldError('locationName', 'Location name is required.'); valid = false; }

        const polygon = this.polygonPoints.map((p) => ({ lat: Number(p.lat.toFixed(8)), lng: Number(p.lng.toFixed(8)) }));
        const hasEnoughPoints = polygon.length >= 4;
        const area = this.polygonAreaSquareMeters(polygon);
        const usePolygon = hasEnoughPoints && area >= 1;

        if (usePolygon) {
            const center = this.syncCenter();
            return {
                name,
                latitude: center.latitude,
                longitude: center.longitude,
                radius_meters: this.legacyRadius || 100,
                polygon,
                is_default: document.getElementById('locationDefault')?.checked
            };
        }

        // Legacy fallback: keep editing a radius-only location that has no polygon yet.
        const latitude = parseFloat(document.getElementById('locationLat')?.value);
        const longitude = parseFloat(document.getElementById('locationLng')?.value);
        if (!hasEnoughPoints && this.currentEditingId && this.legacyRadius && !Number.isNaN(latitude) && !Number.isNaN(longitude)) {
            return {
                name,
                latitude,
                longitude,
                radius_meters: this.legacyRadius,
                is_default: document.getElementById('locationDefault')?.checked
            };
        }

        if (hasEnoughPoints && area < 1) {
            this.setFieldError('locationPolygon', 'These points overlap and enclose no area. Spread them across the actual workspace corners.');
        } else {
            this.setFieldError('locationPolygon', `Add at least 4 polygon points to define the workspace (${polygon.length}/4 added).`);
        }
        return null;
    }

    async handleLocationSubmit() {
        const formData = this.validateLocationForm();
        if (!formData) {
            this.toast('Capture at least 4 polygon points before saving.', 'warning', 'Incomplete geofence');
            return;
        }

        const btn = document.getElementById('submitLocationBtn');
        const wasDisabled = btn?.disabled;
        this.setButtonLoading(btn, true, this.currentEditingId ? 'Updating…' : 'Saving…');
        try {
            const method = this.currentEditingId ? 'PUT' : 'POST';
            if (this.currentEditingId) formData.id = this.currentEditingId;
            const result = await this.request('locations.php', {
                method,
                body: JSON.stringify(formData)
            });
            this.toast(result.message || 'Location saved.', 'success');
            this.resetLocationForm();
            await this.loadLocations();
            await this.loadDashboardStats();
        } catch (error) {
            this.toast(error.message, 'error', 'Save failed');
            if (btn) {
                this.setButtonLoading(btn, false);
                btn.disabled = wasDisabled;
            }
        }
    }

    resetLocationForm() {
        document.getElementById('locationForm')?.reset();
        this.currentEditingId = null;
        this.legacyRadius = null;
        this.polygonPoints = [];
        this.currentLocation = null;
        if (this.polygonLayer && this.map) { this.map.removeLayer(this.polygonLayer); this.polygonLayer = null; }
        this.polygonMarkers.forEach((m) => this.map && this.map.removeLayer(m));
        this.polygonMarkers = [];
        this.updatePolygonUI();
        this.setFormCoordinates('', '');
        const display = document.getElementById('coordinatesDisplay');
        if (display) display.textContent = 'Not captured yet';
        const accuracy = document.getElementById('accuracyInfo');
        if (accuracy) accuracy.textContent = '';
        const coordsAccuracy = document.getElementById('coordinatesAccuracy');
        if (coordsAccuracy) coordsAccuracy.textContent = '';
        const submitBtn = document.getElementById('submitLocationBtn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Add location (capture 4+ points)';
            delete submitBtn.dataset.originalHtml;
        }
    }

    async editLocation(locationId) {
        try {
            const locations = await this.request('locations.php');
            const location = (Array.isArray(locations) ? locations : []).find((loc) => Number(loc.id) === Number(locationId));
            if (!location) {
                this.toast('That location could not be found.', 'error');
                return;
            }
            document.getElementById('locationName').value = location.name;
            document.getElementById('locationDefault').checked = Number(location.is_default) === 1 || location.is_default === true;
            this.currentLocation = {
                latitude: Number(location.latitude),
                longitude: Number(location.longitude)
            };
            this.currentEditingId = locationId;
            const hasPolygon = Array.isArray(location.polygon) && location.polygon.length >= 3;
            this.legacyRadius = hasPolygon ? null : (Number(location.radius_meters) || 100);
            if (hasPolygon) {
                this.setPolygonPoints(location.polygon);
            } else {
                this.polygonPoints = [];
                this.updatePolygonUI();
            }
            document.querySelector('[data-tab="locations"]')?.click();
            this.openMapPicker();
            this.updatePolygonUI();
            this.updateCoordinatesDisplay();
            if (hasPolygon) {
                this.enableLocationSubmit('Update location');
            } else {
                this.showLocationMessage('This location still uses the old radius geofence. Add at least 4 points to convert it to a polygon.', 'info');
            }
            this.toast('Location loaded for editing.', 'info');
        } catch (error) {
            this.toast(error.message, 'error', 'Could not load location');
        }
    }

    async deleteLocation(locationId) {
        const ok = await this.confirmDialog({
            title: 'Delete location',
            message: 'Workers will no longer be able to check in at this geofence.',
            confirmText: 'Delete location',
            danger: true
        });
        if (!ok) return;

        try {
            const result = await this.request('locations.php', {
                method: 'DELETE',
                body: JSON.stringify({ id: locationId })
            });
            this.toast(result.message || 'Location deleted.', 'success');
            await this.loadLocations();
            await this.loadDashboardStats();
        } catch (error) {
            this.toast(error.message, 'error', 'Delete failed');
        }
    }

    async setDefaultLocation(locationId) {
        try {
            const result = await this.request('locations.php', {
                method: 'PUT',
                body: JSON.stringify({ id: locationId, is_default: true })
            });
            this.toast(result.message || 'Default location updated.', 'success');
            await this.loadLocations();
        } catch (error) {
            this.toast(error.message, 'error', 'Update failed');
        }
    }

    /* ---------- Reports ---------- */

    async generateDailyReport() {
        const btn = document.getElementById('dailyReportBtn');
        const container = document.getElementById('dailyReport');
        this.setButtonLoading(btn, true, 'Generating…');
        if (container) container.innerHTML = this.skeletonRows();
        try {
            const report = await this.request('reports.php?type=daily');
            this.displayDailyReport(Array.isArray(report) ? report : []);
        } catch (error) {
            if (container) container.innerHTML = this.emptyState('Report failed', error.message);
            this.toast(error.message, 'error', 'Daily report');
        } finally {
            this.setButtonLoading(btn, false);
        }
    }

    displayDailyReport(report) {
        const container = document.getElementById('dailyReport');
        if (!container) return;
        if (!report.length) {
            container.innerHTML = this.emptyState('No records today', 'There is no attendance to report yet.');
            return;
        }
        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>Name</th><th>Employee ID</th><th>Location</th>
                            <th>Check in</th><th>Check out</th><th>Hours</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${report.map((record) => `
                            <tr>
                                <td>${this.escapeHtml(record.name)}</td>
                                <td>${this.escapeHtml(record.employee_id)}</td>
                                <td>${this.escapeHtml(record.location_name)}</td>
                                <td>${this.formatTime(record.check_in)}</td>
                                <td>${record.check_out ? this.formatTime(record.check_out) : '—'}</td>
                                <td>${record.hours_worked ? this.escapeHtml(String(record.hours_worked).split(':').slice(0, 2).join(':')) : '—'}</td>
                                <td><button class="btn btn-ghost btn-sm" type="button" data-correct="${record.id}" data-in="${this.escapeHtml(record.check_in)}" data-out="${this.escapeHtml(record.check_out || '')}">Correct</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
        container.querySelectorAll('[data-correct]').forEach((btn) => {
            btn.addEventListener('click', () => this.openCorrectModal(btn.dataset.correct, btn.dataset.in, btn.dataset.out));
        });
    }

    async generateMonthlyReport() {
        const workerId = document.getElementById('workerSelectReport')?.value;
        const month = document.getElementById('monthSelect')?.value;
        this.clearFieldError('workerSelectReport');
        if (!workerId) {
            this.setFieldError('workerSelectReport', 'Select a worker first.');
            this.toast('Select a worker to generate the monthly report.', 'warning');
            return;
        }

        const btn = document.getElementById('monthlyReportBtn');
        const container = document.getElementById('monthlyReport');
        this.setButtonLoading(btn, true, 'Generating…');
        if (container) container.innerHTML = this.skeletonRows();
        try {
            const report = await this.request(`reports.php?type=monthly&worker_id=${encodeURIComponent(workerId)}&month=${encodeURIComponent(month)}`);
            this.displayMonthlyReport(Array.isArray(report) ? report : []);
        } catch (error) {
            if (container) container.innerHTML = this.emptyState('Report failed', error.message);
            this.toast(error.message, 'error', 'Monthly report');
        } finally {
            this.setButtonLoading(btn, false);
        }
    }

    displayMonthlyReport(report) {
        const container = document.getElementById('monthlyReport');
        if (!container) return;
        if (!report.length) {
            container.innerHTML = this.emptyState('No records', 'No attendance for that worker in the selected month.');
            return;
        }

        let totalHours = 0;
        let presentDays = 0;
        const rows = report.map((record) => {
            let hoursWorked = 0;
            if (record.hours_worked) {
                const [hours, minutes] = String(record.hours_worked).split(':');
                hoursWorked = parseInt(hours, 10) + parseInt(minutes, 10) / 60;
                totalHours += hoursWorked;
            }
            if (record.status === 'present' || record.status === 'late') presentDays++;
            return `
                <tr>
                    <td>${this.formatDate(record.date)}</td>
                    <td>${this.escapeHtml(record.location_name)}</td>
                    <td>${this.formatTime(record.check_in)}</td>
                    <td>${record.check_out ? this.formatTime(record.check_out) : '—'}</td>
                    <td>${hoursWorked > 0 ? hoursWorked.toFixed(2) + 'h' : '—'}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr><th>Date</th><th>Location</th><th>Check in</th><th>Check out</th><th>Hours</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="summary-card">
                <h4>Summary</h4>
                <p><strong>Present days:</strong> ${presentDays}</p>
                <p><strong>Total hours:</strong> ${totalHours.toFixed(2)}</p>
                <p><strong>Overtime:</strong> ${report.reduce((s, r) => s + (Number(r.overtime_minutes) || 0), 0)} minutes</p>
                <p><strong>Average per day:</strong> ${presentDays > 0 ? (totalHours / presentDays).toFixed(2) : '0.00'} hours</p>
            </div>
        `;
    }

    statusBadge(record) {
        if (record.missed_checkout == 1 || record.missed_checkout === true) return '<span class="badge badge-warn">Missed out</span>';
        if (record.status === 'late') return '<span class="badge badge-warn">Late</span>';
        if (record.is_manual == 1) return '<span class="badge badge-muted">Corrected</span>';
        return '<span class="badge badge-ok">Present</span>';
    }

    liveList(items, formatter) {
        if (!items || !items.length) return '<div class="live-item">None</div>';
        return items.map((item) => `<div class="live-item">${formatter(item)}</div>`).join('');
    }

    renderLiveBoard(live) {
        if (!live) return;
        const onSite = document.getElementById('liveOnSite');
        const late = document.getElementById('liveLate');
        const missing = document.getElementById('liveMissing');
        const missed = document.getElementById('liveMissed');
        if (onSite) onSite.innerHTML = this.liveList(live.on_site, (w) => `${this.escapeHtml(w.name)} · ${this.formatTime(w.check_in)}`);
        if (late) late.innerHTML = this.liveList(live.late, (w) => `${this.escapeHtml(w.name)} · ${this.formatTime(w.check_in)}`);
        if (missing) missing.innerHTML = this.liveList(live.not_arrived, (w) => this.escapeHtml(w.name));
        if (missed) missed.innerHTML = this.liveList(live.missed_checkout, (w) => `${this.escapeHtml(w.name)} · ${this.formatTime(w.check_in)}`);
    }

    async loadLiveBoard() {
        try {
            const live = await this.request('reports.php?type=live');
            this.renderLiveBoard(live);
            this.animateCount(document.getElementById('onSiteNow'), live?.counts?.on_site || 0);
        } catch (e) {}
    }

    async loadAlerts() {
        try {
            const data = await this.request('alerts.php');
            const count = document.getElementById('alertCount');
            if (count) count.textContent = data.unread || 0;
            const list = document.getElementById('alertList');
            if (!list) return;
            const alerts = data.alerts || [];
            if (!alerts.length) {
                list.innerHTML = this.emptyState('No alerts', 'Exceptions will appear here.');
                return;
            }
            list.innerHTML = alerts.map((a) => `
                <div class="alert-row">
                    <span>${this.escapeHtml(a.message)}</span>
                    <span class="badge ${a.is_read == 1 ? 'badge-muted' : 'badge-warn'}">${this.escapeHtml(a.type)}</span>
                </div>
            `).join('');
        } catch (e) {}
    }

    async markAlertsRead() {
        try {
            await this.request('alerts.php', { method: 'PUT', body: JSON.stringify({}) });
            this.toast('Alerts marked read.', 'success');
            this.loadAlerts();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async loadShifts() {
        try {
            this.shifts = await this.request('shifts.php');
            const tbody = document.querySelector('#shiftsTable tbody');
            const select = document.getElementById('workerShift');
            if (select) {
                const current = select.value;
                select.innerHTML = '<option value="">Default shift</option>' + (this.shifts || []).map((s) =>
                    `<option value="${s.id}">${this.escapeHtml(s.name)}</option>`).join('');
                if (current) select.value = current;
            }
            if (!tbody) return;
            tbody.innerHTML = (this.shifts || []).map((s) => `
                <tr>
                    <td>${this.escapeHtml(s.name)}</td>
                    <td>${this.escapeHtml(String(s.start_time).slice(0,5))}–${this.escapeHtml(String(s.end_time).slice(0,5))}</td>
                    <td>${this.escapeHtml(s.late_grace_minutes)}m</td>
                    <td>${this.escapeHtml(s.break_minutes)}m</td>
                    <td>${this.escapeHtml(s.work_days)}</td>
                    <td><button class="btn btn-danger btn-sm" type="button" data-del-shift="${s.id}">Delete</button></td>
                </tr>
            `).join('');
            tbody.querySelectorAll('[data-del-shift]').forEach((btn) => {
                btn.addEventListener('click', () => this.deleteShift(Number(btn.dataset.delShift)));
            });
        } catch (error) {
            this.toast(error.message, 'error', 'Shifts');
        }
    }

    async handleShiftSubmit() {
        const payload = {
            name: document.getElementById('shiftName')?.value.trim(),
            start_time: document.getElementById('shiftStart')?.value,
            end_time: document.getElementById('shiftEnd')?.value,
            late_grace_minutes: document.getElementById('shiftGrace')?.value,
            break_minutes: document.getElementById('shiftBreak')?.value,
            overtime_after_minutes: document.getElementById('shiftOvertime')?.value,
            work_days: document.getElementById('shiftDays')?.value
        };
        if (!payload.name || !payload.start_time || !payload.end_time) {
            this.toast('Name, start, and end are required.', 'warning');
            return;
        }
        try {
            const result = await this.request('shifts.php', { method: 'POST', body: JSON.stringify(payload) });
            this.toast(result.message || 'Shift saved.', 'success');
            document.getElementById('shiftForm')?.reset();
            document.getElementById('shiftStart').value = '08:00';
            document.getElementById('shiftEnd').value = '17:00';
            await this.loadShifts();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async deleteShift(id) {
        const ok = await this.confirmDialog({ title: 'Delete shift', message: 'Workers on this shift will be moved to another shift.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try {
            await this.request('shifts.php', { method: 'DELETE', body: JSON.stringify({ id }) });
            this.toast('Shift deleted.', 'success');
            this.loadShifts();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async resetDevice(workerId) {
        const ok = await this.confirmDialog({ title: 'Reset device', message: 'This worker will be able to sign in from a new phone.', confirmText: 'Reset', danger: false });
        if (!ok) return;
        try {
            const result = await this.request('workers.php', { method: 'PUT', body: JSON.stringify({ id: workerId, reset_device: true }) });
            this.toast(result.message || 'Device reset.', 'success');
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    toLocalInput(value) {
        if (!value) return '';
        const d = new Date(value.replace(' ', 'T'));
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    openCorrectModal(id, checkIn, checkOut) {
        document.getElementById('correctId').value = id;
        document.getElementById('correctCheckIn').value = this.toLocalInput(checkIn);
        document.getElementById('correctCheckOut').value = this.toLocalInput(checkOut);
        document.getElementById('correctReason').value = '';
        document.getElementById('correctModal')?.classList.add('show');
    }

    async saveCorrection() {
        const id = document.getElementById('correctId')?.value;
        const reason = document.getElementById('correctReason')?.value.trim();
        const checkIn = document.getElementById('correctCheckIn')?.value;
        const checkOut = document.getElementById('correctCheckOut')?.value;
        if (!reason) { this.toast('A reason is required.', 'warning'); return; }
        try {
            const payload = { id: Number(id), reason, check_in: checkIn ? checkIn.replace('T', ' ') + ':00' : undefined };
            payload.check_out = checkOut ? checkOut.replace('T', ' ') + ':00' : '';
            await this.request('attendance.php', { method: 'PUT', body: JSON.stringify(payload) });
            document.getElementById('correctModal')?.classList.remove('show');
            this.toast('Correction saved.', 'success');
            this.loadDashboardStats();
            this.generateDailyReport();
            this.loadAudit();
        } catch (error) {
            this.toast(error.message, 'error');
        }
    }

    async loadPayroll() {
        const from = document.getElementById('payrollFrom')?.value;
        const to = document.getElementById('payrollTo')?.value;
        const container = document.getElementById('payrollReport');
        try {
            this.payrollData = await this.request(`reports.php?type=payroll&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
            const rows = this.payrollData.rows || [];
            if (!rows.length) {
                container.innerHTML = this.emptyState('No payroll rows', 'No workers in this period.');
                return;
            }
            container.innerHTML = `
                <div class="table-wrap"><table>
                    <thead><tr><th>ID</th><th>Name</th><th>Regular</th><th>OT</th><th>Total</th><th>Late</th><th>Absent</th><th>Missed out</th></tr></thead>
                    <tbody>${rows.map((r) => `<tr>
                        <td>${this.escapeHtml(r.employee_id)}</td><td>${this.escapeHtml(r.name)}</td>
                        <td>${r.regular_hours}</td><td>${r.overtime_hours}</td><td>${r.total_hours}</td>
                        <td>${r.late_count}</td><td>${r.absent_days}</td><td>${r.missed_checkout_count}</td>
                    </tr>`).join('')}</tbody>
                </table></div>`;
        } catch (error) {
            this.toast(error.message, 'error', 'Payroll');
        }
    }

    exportPayroll(kind) {
        const rows = this.payrollData?.rows;
        if (!rows) { this.toast('Load payroll first.', 'warning'); return; }
        const headers = ['Employee ID', 'Name', 'Regular hours', 'Overtime hours', 'Total hours', 'Late', 'Absent days', 'Missed checkouts'];
        const data = rows.map((r) => [r.employee_id, r.name, r.regular_hours, r.overtime_hours, r.total_hours, r.late_count, r.absent_days, r.missed_checkout_count]);
        const from = this.payrollData.from;
        const to = this.payrollData.to;
        if (kind === 'xls') {
            const table = `<table><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>${data.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
            const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body>${table}</body></html>`;
            this.downloadBlob(html, `payroll-${from}-to-${to}.xls`, 'application/vnd.ms-excel');
            return;
        }
        const csv = '\uFEFF' + [headers, ...data].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        this.downloadBlob(csv, `payroll-${from}-to-${to}.csv`, 'text/csv;charset=utf-8');
    }

    downloadBlob(content, filename, type) {
        const blob = new Blob([content], { type });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async loadAudit() {
        try {
            const rows = await this.request('reports.php?type=audit');
            const tbody = document.querySelector('#auditTable tbody');
            if (!tbody) return;
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="5">${this.emptyState('No audit events', 'Activity in this organization will appear here.')}</td></tr>`;
                return;
            }
            tbody.innerHTML = rows.map((r) => `
                <tr>
                    <td>${this.escapeHtml(r.created_at)}</td>
                    <td>${this.escapeHtml(r.actor_label || `${r.actor_role} #${r.actor_id}`)}</td>
                    <td>${this.escapeHtml(r.action)}</td>
                    <td>${this.escapeHtml(r.entity)} ${r.entity_id || ''}</td>
                    <td>${this.escapeHtml(String(r.details || '').slice(0, 120))}</td>
                </tr>
            `).join('');
        } catch (error) {
            this.toast(error.message, 'error', 'Audit');
        }
    }

    logout() {
        // Clear local state and leave immediately; the server session is revoked in the background.
        const options = {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, GeoSession.headers()),
            credentials: 'include',
            keepalive: true,
            body: JSON.stringify({ action: 'logout' })
        };
        try { fetch(`${this.baseUrl}/auth.php`, options).catch(() => {}); } catch (e) {}
        GeoSession.clear();
        window.location.replace('admin-login.html');
    }
}

const admin = new AdminDashboard();
