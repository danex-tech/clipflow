import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import './App.css';
import { saveSession, loadSession, clearSession } from './utils/session';

const DEFAULT_API_BASE = 
import.meta.env.VITE_API_BASE2 || 
'http://localhost:5000/api';
const THEME_STORAGE_KEY = 'clipflow-theme';

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function formatBytes(bytes, isEstimate = false) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  const prefix = isEstimate ? '~' : '';
  if (mb < 1000) return `${prefix}${mb.toFixed(1)} MB`;
  return `${prefix}${(mb / 1024).toFixed(2)} GB`;
}

// Uniquely identifies a "quality + trim range" combination, so we can
// remember a completed download per setting and bring its "ready" state
// back when the user re-selects that same combination.
function makeJobKey(formatId, trimEnabled, startSec, endSec) {
  if (!formatId) return null;
  return `${formatId}::${trimEnabled ? `${startSec}-${endSec}` : 'full'}`;
}

// The CF monogram: literal overlapping letterforms so it reads unmistakably
// as "C" + "F" merged into one mark, in the app's two accent colors.
function Logo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <text x="1" y="35" fontFamily="'Space Grotesk', sans-serif" fontWeight="700" fontSize="34" fill="var(--cyan)">
        C
      </text>
      <text x="16" y="35" fontFamily="'Space Grotesk', sans-serif" fontWeight="700" fontSize="34" fill="var(--magenta)" opacity="0.92">
        F
      </text>
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

function ThemeIcon({ theme }) {
  if (theme === 'light') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === 'dark') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function SkeletonCard() {
  return (
    <section className="result-card">
      <div className="video-summary">
        <div className="skeleton thumb-skeleton" />
        <div className="video-meta" style={{ flex: 1 }}>
          <div className="skeleton skel-line" style={{ width: '80%', height: 16, marginBottom: 8 }} />
          <div className="skeleton skel-line" style={{ width: '40%', height: 12 }} />
        </div>
      </div>
      <div className="section-block">
        <div className="skeleton skel-line" style={{ width: 60, height: 10, marginBottom: 12 }} />
        <div className="quality-grid">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton skel-chip" />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const [themePref, setThemePref] = useState(() => {
    if (typeof window === 'undefined') return 'system';
    return localStorage.getItem(THEME_STORAGE_KEY) || 'system';
  });

  useLayoutEffect(() => {
    const applyTheme = () => {
      let effective = themePref;
      if (themePref === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }
      document.documentElement.setAttribute('data-theme', effective);
    };
    applyTheme();

    if (themePref === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      mq.addEventListener('change', applyTheme);
      return () => mq.removeEventListener('change', applyTheme);
    }
  }, [themePref]);

  const chooseTheme = (t) => {
    setThemePref(t);
    localStorage.setItem(THEME_STORAGE_KEY, t);
  };

  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState('');

  const [selectedFormatId, setSelectedFormatId] = useState(null);

  const [trimEnabled, setTrimEnabled] = useState(false);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);

  // The job currently being tracked for the SELECTED quality/trim setting.
  const [job, setJob] = useState(null);
  // Every completed/failed/cancelled job we've seen this session, keyed by
  // quality+trim, so switching back to a setting you already downloaded
  // brings its "ready" state back instead of losing it.
  const [jobsCache, setJobsCache] = useState({});
  const [downloadError, setDownloadError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef(null);
  const jobKeyRef = useRef(null); // key of the job currently in flight

  const jobBusy = job && ['submitting', 'waiting', 'active'].includes(job.state);

  // --- Restore the most recent session on first load (survives refresh) ---
  useEffect(() => {
    const saved = loadSession();
    if (!saved) return;

    setUrl(saved.url || '');
    setInfo(saved.info || null);
    setSelectedFormatId(saved.selectedFormatId || null);
    setTrimEnabled(saved.trimEnabled || false);
    setStartSec(saved.startSec || 0);
    setEndSec(saved.endSec || 0);

    if (saved.jobId) {
      jobKeyRef.current = makeJobKey(saved.selectedFormatId, saved.trimEnabled, saved.startSec, saved.endSec);
      (async () => {
        try {
          const res = await fetch(`${DEFAULT_API_BASE}/download/status/${saved.jobId}`, { cache: 'no-store' });
          const data = await res.json();
          if (res.ok) {
            const restored = {
              id: saved.jobId,
              state: data.state,
              progress: data.progress,
              failedReason: data.failedReason,
              attemptsMade: data.attemptsMade,
            };
            setJob(restored);
            if (['completed', 'failed', 'cancelled'].includes(data.state)) {
              setJobsCache((prev) => ({ ...prev, [jobKeyRef.current]: restored }));
            }
          } else {
            // Job genuinely no longer exists server-side — drop the stale session quietly.
            clearSession();
          }
        } catch {
          // Network hiccup while restoring — leave the saved session in
          // place; the user can just try again once connectivity is back.
        }
      })();
    }
    // Only run once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForNewVideo = () => {
    setInfo(null);
    setSelectedFormatId(null);
    setTrimEnabled(false);
    setJob(null);
    setJobsCache({});
    setDownloadError('');
    setInfoError('');
    clearSession();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setInfoError('Could not read clipboard — paste manually instead.');
    }
  };

  const fetchInfo = async () => {
    if (!url.trim()) return;
    if (jobBusy) {
      setInfoError('A download is currently in progress. Please wait for it to finish, or cancel it, before fetching a new video.');
      return;
    }
    resetForNewVideo();
    setInfoLoading(true);
    try {
      const res = await fetch(`${DEFAULT_API_BASE}/video-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Failed to fetch video info');
      setInfo(data);
      const firstFormatId = data.formats?.length ? data.formats[0].format_id : null;
      if (firstFormatId) setSelectedFormatId(firstFormatId);
      setEndSec(data.duration || 0);

      saveSession({
        url: url.trim(),
        info: data,
        selectedFormatId: firstFormatId,
        trimEnabled: false,
        startSec: 0,
        endSec: data.duration || 0,
        jobId: null,
      });
    } catch (err) {
      setInfoError(err.message);
    } finally {
      setInfoLoading(false);
    }
  };

  // Switching quality or trim range: if we've already completed a download
  // for that exact combination this session, bring its "ready" state back.
  // Otherwise show nothing until the user starts a fresh download.
  const switchTo = (formatId, trim, start, end) => {
    if (jobBusy) return;
    const key = makeJobKey(formatId, trim, start, end);
    setJob(jobsCache[key] || null);
    saveSession({
      url: url.trim(), info, selectedFormatId: formatId, trimEnabled: trim,
      startSec: start, endSec: end, jobId: (jobsCache[key] || null)?.id || null,
    });
  };

  const selectFormat = (formatId) => {
    setSelectedFormatId(formatId);
    switchTo(formatId, trimEnabled, startSec, endSec);
  };

  const updateStart = (val) => {
    setStartSec(val);
    switchTo(selectedFormatId, trimEnabled, val, endSec);
  };

  const updateEnd = (val) => {
    setEndSec(val);
    switchTo(selectedFormatId, trimEnabled, startSec, val);
  };

  const toggleTrim = (checked) => {
    setTrimEnabled(checked);
    switchTo(selectedFormatId, checked, startSec, endSec);
  };

  const startDownload = async () => {
    setDownloadError('');
    const key = makeJobKey(selectedFormatId, trimEnabled, startSec, endSec);
    jobKeyRef.current = key;
    setJob({ id: null, state: 'submitting', progress: { stage: 'queued', percent: 0 } });
    try {
      const selectedFormat = info?.formats?.find((f) => f.format_id === selectedFormatId);
      const body = {
        url: url.trim(),
        formatId: selectedFormatId,
        hasAudio: Boolean(selectedFormat?.hasAudio),
        title: info?.title,
        duration: info?.duration,
      };
      if (trimEnabled) {
        body.startTime = formatTime(startSec);
        body.endTime = formatTime(endSec);
      }
      const res = await fetch(`${DEFAULT_API_BASE}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.details || data.error || 'Failed to start download');
      const newJob = { id: data.jobId, state: 'waiting', progress: { stage: 'queued', percent: 0 } };
      setJob(newJob);
      saveSession({
        url: url.trim(), info, selectedFormatId, trimEnabled, startSec, endSec, jobId: data.jobId,
      });
    } catch (err) {
      setDownloadError(err.message);
      setJob(null);
    }
  };

  const cancelDownload = async () => {
    if (!job?.id || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`${DEFAULT_API_BASE}/download/cancel/${job.id}`, { method: 'POST' });
    } catch {
      // Even if this request itself fails, we still reflect the cancellation
      // locally below — the worker's own periodic check will catch up.
    }
    clearInterval(pollRef.current);
    setJob((prev) => (prev ? { ...prev, state: 'cancelled' } : prev));
    clearSession();
    setCancelling(false);
  };

  const pollStatus = useCallback(async () => {
    if (!job?.id) return;
    try {
      const res = await fetch(`${DEFAULT_API_BASE}/download/status/${job.id}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Status check failed');

      const updated = {
        id: job.id,
        state: data.state,
        progress: data.progress,
        failedReason: data.failedReason,
        attemptsMade: data.attemptsMade,
        queuePosition: data.queuePosition,
        totalWaiting: data.totalWaiting,
      };
      setJob(updated);
      saveSession({
        url: url.trim(), info, selectedFormatId, trimEnabled, startSec, endSec, jobId: job.id,
      });

      if (['completed', 'failed', 'cancelled'].includes(data.state)) {
        clearInterval(pollRef.current);
        const key = jobKeyRef.current;
        if (key) {
          setJobsCache((prev) => ({ ...prev, [key]: updated }));
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    } catch (err) {
      setDownloadError(err.message);
      clearInterval(pollRef.current);
    }
  }, [job?.id]);

  useEffect(() => {
    if (job?.id && (job.state === 'waiting' || job.state === 'active')) {
      pollRef.current = setInterval(pollStatus, 2000);
      return () => clearInterval(pollRef.current);
    }
  }, [job?.id, job?.state, pollStatus]);

  const selectedFormat = info?.formats?.find((f) => f.format_id === selectedFormatId);
  const duration = info?.duration || 0;
  const isRetrying = jobBusy && job.progress?.attempt > 1;

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <span className="brand-name">ClipFlow</span>
        </div>
        <div className="topbar-right">
          <div className="platform-chips">
            {['YouTube', 'TikTok', 'Instagram', 'Facebook', 'X', 'Threads'].map((p) => (
              <span key={p} className="platform-chip">{p}</span>
            ))}
          </div>
          <div className="theme-switch">
            {['light', 'dark', 'system'].map((t) => (
              <button
                key={t}
                className={`theme-btn ${themePref === t ? 'active' : ''}`}
                onClick={() => chooseTheme(t)}
                aria-label={`${t} mode`}
                title={`${t.charAt(0).toUpperCase() + t.slice(1)} mode`}
              >
                <ThemeIcon theme={t} />
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="hero">
        <p className="eyebrow">Paste. Pick. Play offline.</p>
        <h1 className="headline">
          Paste any video link.<br />
          <span className="headline-accent">Pull it down in any quality.</span>
        </h1>

        <div className="url-bar">
          <div className="url-input-wrap">
            <input
              type="text"
              placeholder="https://youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="url-input"
              onKeyDown={(e) => e.key === 'Enter' && fetchInfo()}
            />
            <button className="paste-icon-btn" onClick={handlePaste} type="button" aria-label="Paste from clipboard" title="Paste from clipboard">
              <ClipboardIcon />
            </button>
          </div>
          <button className="btn btn-primary" onClick={fetchInfo} disabled={infoLoading || !url.trim() || jobBusy}>
            {infoLoading ? 'Fetching…' : 'Fetch'}
          </button>
        </div>

        {infoError && <p className="error-text">{infoError}</p>}
      </main>

      {infoLoading && <SkeletonCard />}

      {!infoLoading && info && (
        <section className="result-card">
          <div className="video-summary">
            <img src={info.thumbnail} alt="" className="thumb" />
            <div className="video-meta">
              <h2 className="video-title">{info.title}</h2>
              <p className="video-sub">
                {info.uploader} <span className="dot-sep">•</span>{' '}
                <span className="mono">{formatTime(duration)}</span>
              </p>
            </div>
          </div>

          <div className="section-block">
            <p className="section-label">Quality</p>
            <div className={`quality-grid ${jobBusy ? 'controls-disabled' : ''}`}>
              {info.formats.map((f) => {
                const clipDuration = trimEnabled ? Math.max(0, endSec - startSec) : duration;
                const displaySize = trimEnabled && duration > 0 && f.filesize
                  ? f.filesize * (clipDuration / duration)
                  : f.filesize;
                return (
                  <button
                    key={f.format_id}
                    className={`quality-chip ${selectedFormatId === f.format_id ? 'active' : ''}`}
                    onClick={() => selectFormat(f.format_id)}
                    disabled={jobBusy}
                  >
                    <span className="quality-label">{f.quality}</span>
                    <span className="quality-size mono">{formatBytes(displaySize, trimEnabled)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="section-block">
            <div className="trim-header">
              <p className="section-label">Clip range</p>
              <label className={`toggle ${jobBusy ? 'controls-disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={trimEnabled}
                  disabled={jobBusy}
                  onChange={(e) => toggleTrim(e.target.checked)}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
                <span className="toggle-label">Trim</span>
              </label>
            </div>

            <div className={`timeline ${!trimEnabled || jobBusy ? 'timeline-disabled' : ''}`}>
              <div className="timeline-track">
                <div
                  className="timeline-fill"
                  style={{
                    left: `${duration ? (startSec / duration) * 100 : 0}%`,
                    right: `${duration ? 100 - (endSec / duration) * 100 : 0}%`,
                  }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={duration}
                value={startSec}
                disabled={!trimEnabled || jobBusy}
                onChange={(e) => updateStart(Math.min(Number(e.target.value), endSec - 1))}
                className="range range-start"
              />
              <input
                type="range"
                min={0}
                max={duration}
                value={endSec}
                disabled={!trimEnabled || jobBusy}
                onChange={(e) => updateEnd(Math.max(Number(e.target.value), startSec + 1))}
                className="range range-end"
              />
              <div className="timeline-labels">
                <span className="mono timecode">{formatTime(startSec)}</span>
                <span className="mono timecode dim">{formatTime(duration)}</span>
                <span className="mono timecode">{formatTime(endSec)}</span>
              </div>
            </div>
          </div>

          <div className="download-row">
            <button
              className="btn btn-primary btn-large"
              onClick={startDownload}
              disabled={!selectedFormatId || jobBusy}
            >
              Download {selectedFormat?.quality || ''}
              {trimEnabled ? ` · ${formatTime(startSec)}–${formatTime(endSec)}` : ''}
            </button>
          </div>

          {job && (
            <div className="job-status">
              {jobBusy && (
                <>
                  {job.state === 'waiting' && typeof job.queuePosition === 'number' && job.queuePosition > 0 && (
                    <p className="queue-position">
                      🕐 {job.queuePosition} {job.queuePosition === 1 ? 'job' : 'jobs'} ahead of you in the queue
                      {job.totalWaiting ? ` (${job.totalWaiting} waiting total)` : ''}
                    </p>
                  )}
                  {isRetrying && (
                    <p className="retry-warning">
                      ⚠ Weak connection detected — retrying download
                      (attempt {job.progress.attempt} of {job.progress.maxAttempts})
                    </p>
                  )}
                  <div className="rec-row">
                    <span className="rec-row-left">
                      <span className="rec-dot" />
                      <span className="job-stage">{job.progress?.stage || 'queued'}…</span>
                    </span>
                    <span className="job-percent mono">{job.progress?.percent || 0}%</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${job.progress?.percent || 0}%` }}
                    />
                  </div>
                  <button
                    className="btn btn-ghost cancel-btn"
                    onClick={cancelDownload}
                    disabled={cancelling}
                  >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                </>
              )}

              {job.state === 'completed' && (
                <a
                  className="btn btn-success btn-large"
                  href={`${DEFAULT_API_BASE}/download/result/${job.id}`}
                >
                  ✓ Ready — Save file
                </a>
              )}

              {job.state === 'cancelled' && (
                <p className="cancelled-text">Download cancelled.</p>
              )}

              {job.state === 'failed' && (
                <p className="error-text">
                  {job.attemptsMade >= (job.progress?.maxAttempts || 5)
                    ? `Failed after ${job.attemptsMade} attempts due to a poor connection. Please check your internet and try again.`
                    : 'Something went wrong processing this download.'}
                </p>
              )}
            </div>
          )}

          {downloadError && <p className="error-text">{downloadError}</p>}
        </section>
      )}

      <footer className="footer">
        <p>Works with links from YouTube, TikTok, Instagram, Facebook, X, and Threads.</p>
      </footer>
    </div>
  );
}