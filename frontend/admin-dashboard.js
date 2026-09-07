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
        this.marker = null;
        this.radiusCircle = null;
        this.tileLayer = null;
        this.locationWatchId = null;
        this.isTracking = false;
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
        const theme = localStorage.getItem('geo_theme') || 'dark';
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
        document.getElementById('locationRadius')?.addEventListener('input', () => this.updateRadiusCircle());
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

        ['employeeId', 'workerName', 'workerEmail', 'workerPin', 'workerPassword', 'locationName', 'locationLat', 'locationLng', 'locationRadius', 'workerSelectReport']
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

    /* ---------- Location detection ---------- */

    setupEnhancedLocationGetter() {
        this.setupLocationButtonListeners();
    }

    setupLocationButtonListeners() {
        document.getElementById('startAutoLocationBtn')?.addEventListener('click', () => this.startAutoLocation());
        document.getElementById('openMapPickerBtn')?.addEventListener('click', () => this.openMapPicker());
        document.getElementById('useDefaultOfficeBtn')?.addEventListener('click', () => this.useDefaultOffice());
        document.getElementById('stopAutoLocationBtn')?.addEventListener('click', () => this.stopAutoLocation());
    }

    startAutoLocation() {
        if (!navigator.geolocation) {
            this.showLocationMessage('Geolocation is not supported by this browser.', 'error');
            this.toast('Geolocation is not supported by this browser.', 'error');
            return;
        }

        const options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 };
        this.showLocationMessage('Detecting your location…', 'info');
        this.updateAutoLocationStatus('Detecting your location…', 'active');

        navigator.geolocation.getCurrentPosition(
            (position) => {
                this.handleLocationSuccess(position);
                this.locationWatchId = navigator.geolocation.watchPosition(
                    (pos) => this.handleLocationSuccess(pos),
                    (error) => this.handleLocationError(error),
                    options
                );
                this.isTracking = true;
                this.updateLocationButtons(true);
                this.showLocationMessage('Location tracking is active. Coordinates update as you move.', 'success');
                this.toast('Location tracking started.', 'success');
            },
            (error) => this.handleLocationError(error),
            options
        );
    }

    handleLocationSuccess(position) {
        this.currentLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy
        };
        this.setFormCoordinates(this.currentLocation.latitude, this.currentLocation.longitude);
        this.updateCoordinatesDisplay();
        this.updateAccuracyDisplay();
        this.updateAutoLocationStatus('Location tracking active', 'active');
        this.enableLocationSubmit();
        this.clearFieldError('locationLat');
        this.clearFieldError('locationLng');
        if (this.map) {
            this.map.setView([this.currentLocation.latitude, this.currentLocation.longitude], 16);
            this.updateMapMarker([this.currentLocation.latitude, this.currentLocation.longitude]);
        }
    }

    handleLocationError(error) {
        const messages = {
            1: 'Location access denied. Allow location in your browser settings and try again.',
            2: 'Location unavailable. Check GPS or Wi-Fi and try again.',
            3: 'Location request timed out. Try again or pick a point on the map.'
        };
        const message = messages[error.code] || 'Unable to get your location.';
        this.showLocationMessage(message, 'error');
        this.toast(message, 'error', 'Location failed');
        this.updateAutoLocationStatus('Location detection failed', 'inactive');
        this.updateLocationButtons(false);
    }

    stopAutoLocation() {
        if (this.locationWatchId) {
            navigator.geolocation.clearWatch(this.locationWatchId);
            this.locationWatchId = null;
        }
        this.isTracking = false;
        this.updateLocationButtons(false);
        this.showLocationMessage('Location tracking stopped.', 'info');
        this.updateAutoLocationStatus('Ready to detect your location', 'inactive');
    }

    updateLocationButtons(isTracking) {
        const startBtn = document.getElementById('startAutoLocationBtn');
        const stopBtn = document.getElementById('stopAutoLocationBtn');
        if (startBtn) startBtn.style.display = isTracking ? 'none' : 'inline-flex';
        if (stopBtn) stopBtn.style.display = isTracking ? 'inline-flex' : 'none';
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
        const dark = !document.body.classList.contains('light');
        const url = dark
            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
            : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
        this.tileLayer = L.tileLayer(url, { attribution: '© OpenStreetMap' }).addTo(this.map);
    }

    openMapPicker() {
        const mapContainer = document.getElementById('mapContainer');
        mapContainer?.classList.add('open');

        if (!this.map) {
            this.map = L.map('mapContainer').setView([40.7128, -74.0060], 13);
            this.refreshMapTiles();
            this.map.on('click', (e) => {
                this.currentLocation = {
                    latitude: e.latlng.lat,
                    longitude: e.latlng.lng,
                    accuracy: this.currentLocation?.accuracy
                };
                this.setFormCoordinates(e.latlng.lat, e.latlng.lng);
                this.updateCoordinatesDisplay();
                this.updateMapMarker(e.latlng);
                this.enableLocationSubmit();
                this.clearFieldError('locationLat');
                this.clearFieldError('locationLng');
                this.showLocationMessage('Map point selected. You can still drag the pin by clicking elsewhere.', 'success');
            });
        }

        setTimeout(() => this.map.invalidateSize(), 320);

        if (this.currentLocation) {
            this.map.setView([this.currentLocation.latitude, this.currentLocation.longitude], 16);
            this.updateMapMarker([this.currentLocation.latitude, this.currentLocation.longitude]);
        }
    }

    updateMapMarker(latlng) {
        if (this.marker) this.map.removeLayer(this.marker);
        const point = Array.isArray(latlng) ? { lat: latlng[0], lng: latlng[1] } : latlng;
        this.marker = L.marker(point).addTo(this.map)
            .bindPopup(`
                <strong>Selected location</strong><br>
                Lat ${Number(point.lat).toFixed(6)}<br>
                Lng ${Number(point.lng).toFixed(6)}
            `)
            .openPopup();
        this.updateRadiusCircle();
    }

    updateRadiusCircle() {
        if (!this.map || !this.marker) return;
        if (this.radiusCircle) this.map.removeLayer(this.radiusCircle);
        const latlng = this.marker.getLatLng();
        const radius = parseInt(document.getElementById('locationRadius')?.value, 10) || 100;
        this.radiusCircle = L.circle(latlng, {
            color: '#6366f1',
            fillColor: '#6366f1',
            fillOpacity: 0.18,
            radius
        }).addTo(this.map);
    }

    useDefaultOffice() {
        const defaultLocation = { latitude: 40.7128, longitude: -74.0060 };
        this.currentLocation = { ...defaultLocation, accuracy: null };
        this.setFormCoordinates(defaultLocation.latitude, defaultLocation.longitude);
        this.updateCoordinatesDisplay();
        this.showLocationMessage('Default office coordinates loaded. Adjust on the map if needed.', 'success');
        this.toast('Default office coordinates loaded.', 'info');
        this.enableLocationSubmit();
        if (this.map) {
            this.map.setView([defaultLocation.latitude, defaultLocation.longitude], 15);
            this.updateMapMarker([defaultLocation.latitude, defaultLocation.longitude]);
        }
    }

    showLocationMessage(message, type) {
        const el = document.getElementById('locationMessage');
        if (!el) return;
        el.textContent = message;
        el.className = `location-message show ${type}`;
        if (type === 'success') {
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
            return `
                <tr>
                    <td>
                        ${this.escapeHtml(location.name)}
                        ${isDefault ? ' <span class="badge badge-muted">Default</span>' : ''}
                    </td>
                    <td>${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}</td>
                    <td>${this.escapeHtml(location.radius_meters)}m</td>
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
        const latitude = parseFloat(document.getElementById('locationLat')?.value);
        const longitude = parseFloat(document.getElementById('locationLng')?.value);
        const radius = parseInt(document.getElementById('locationRadius')?.value, 10);
        let valid = true;

        this.clearFormErrors(['locationName', 'locationLat', 'locationLng', 'locationRadius']);

        if (!name) { this.setFieldError('locationName', 'Location name is required.'); valid = false; }
        if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
            this.setFieldError('locationLat', 'Detect, pick on the map, or use default office.');
            this.setFieldError('locationLng', 'Coordinates are required.');
            valid = false;
        }
        if (Number.isNaN(radius) || radius < 50 || radius > 1000) {
            this.setFieldError('locationRadius', 'Radius must be between 50 and 1000 meters.');
            valid = false;
        }

        return valid ? {
            name,
            latitude,
            longitude,
            radius_meters: radius,
            is_default: document.getElementById('locationDefault')?.checked
        } : null;
    }

    async handleLocationSubmit() {
        const formData = this.validateLocationForm();
        if (!formData) {
            this.toast('Please complete the location details.', 'warning', 'Incomplete form');
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
            document.getElementById('locationForm')?.reset();
            this.currentEditingId = null;
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Add location (detect or pick first)';
                delete btn.dataset.originalHtml;
            }
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

    async editLocation(locationId) {
        try {
            const locations = await this.request('locations.php');
            const location = (Array.isArray(locations) ? locations : []).find((loc) => Number(loc.id) === Number(locationId));
            if (!location) {
                this.toast('That location could not be found.', 'error');
                return;
            }
            document.getElementById('locationName').value = location.name;
            document.getElementById('locationLat').value = location.latitude;
            document.getElementById('locationLng').value = location.longitude;
            document.getElementById('locationRadius').value = location.radius_meters;
            document.getElementById('locationDefault').checked = Number(location.is_default) === 1 || location.is_default === true;
            this.currentLocation = {
                latitude: Number(location.latitude),
                longitude: Number(location.longitude)
            };
            this.currentEditingId = locationId;
            this.enableLocationSubmit('Update location');
            this.updateCoordinatesDisplay();
            document.querySelector('[data-tab="locations"]')?.click();
            this.openMapPicker();
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

    async logout() {
        try {
            await fetch(`${this.baseUrl}/auth.php`, { method: 'POST', headers: GeoSession.headers(), credentials: 'include', body: JSON.stringify({ action: 'logout' }) });
        } catch (e) {}
        GeoSession.clear();
        window.location.replace('admin-login.html');
    }
}

const admin = new AdminDashboard();
