import Head from 'next/head';
import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Helpers ──────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(secs) {
  if (!secs) return '0s';
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function detectPlatform(url) {
  if (!url) return 'unknown';
  try {
    const { hostname } = new URL(url);
    if (hostname === 'www.scribd.com'    || hostname === 'scribd.com')    return 'scribd';
    if (hostname === 'www.slideshare.net' || hostname === 'slideshare.net') return 'slide';
    if (hostname === 'www.everand.com'   || hostname === 'everand.com')   return 'everand';
  } catch {
    // invalid URL — fall through to unknown
  }
  return 'unknown';
}

function platformLabel(p) {
  return { scribd: 'Scribd', slide: 'SlideShare', everand: 'Everand', unknown: 'Unknown' }[p];
}

const STATUS_ICON = {
  pending:    '⏳',
  processing: '⚙️',
  completed:  '✓',
  failed:     '✗',
};

// ─── Component ────────────────────────────────────────────────────
export default function Home() {
  const [url, setUrl]           = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [jobs, setJobs]         = useState([]);
  const [toasts, setToasts]     = useState([]);

  const toastId   = useRef(0);
  const jobsRef   = useRef([]);

  // keep ref in sync so polling closure is always current
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // ── toast helpers ──────────────────────────────────────────────
  const addToast = useCallback((message, type = 'info') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  // ── polling ────────────────────────────────────────────────────
  const pollOnce = useCallback(async () => {
    const active = jobsRef.current.filter(
      j => j.status === 'pending' || j.status === 'processing'
    );
    if (!active.length) return;

    await Promise.all(
      active.map(async job => {
        try {
          const res  = await fetch(`/api/status?jobId=${job.id}`);
          if (!res.ok) return;
          const data = await res.json();

          const wasActive = job.status !== 'completed' && job.status !== 'failed';
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, ...data } : j));

          if (wasActive) {
            if (data.status === 'completed') {
              addToast(`✓ Downloaded: ${data.filename || 'file'}`, 'success');
            } else if (data.status === 'failed') {
              addToast(`✗ Failed: ${data.message || 'Unknown error'}`, 'error');
            }
          }
        } catch {
          // ignore transient network errors
        }
      })
    );
  }, [addToast]);

  useEffect(() => {
    const id = setInterval(pollOnce, 2000);
    return () => clearInterval(id);
  }, [pollOnce]);

  // ── form submit ────────────────────────────────────────────────
  const handleSubmit = async e => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    setFormError('');
    setSubmitting(true);

    try {
      const res  = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setFormError(data.error || 'Failed to start download');
        return;
      }

      setJobs(prev => [{
        id:          data.jobId,
        url:         trimmed,
        status:      'pending',
        progress:    0,
        message:     'Queued...',
        currentPage: 0,
        totalPages:  0,
        filename:    null,
        fileSize:    null,
        elapsedTime: 0,
      }, ...prev]);

      setUrl('');
      addToast('Job added to queue', 'info');
    } catch {
      setFormError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // ── derived lists ──────────────────────────────────────────────
  const activeJobs  = jobs.filter(j => j.status === 'pending' || j.status === 'processing');
  const doneJobs    = jobs.filter(j => j.status === 'completed' || j.status === 'failed');

  // ─────────────────────────────────────────────────────────────
  return (
    <>
      <Head>
        <title>Document Downloader — Scribd · SlideShare · Everand</title>
        <meta name="description" content="Download Scribd/SlideShare documents as PDF, or save Everand podcast episodes as MP3" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📄</text></svg>" />
      </Head>

      {/* Background decoration */}
      <div className="app-bg" aria-hidden="true" />

      {/* Toast container */}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span>{t.type === 'success' ? '✓' : t.type === 'error' ? '✗' : 'ℹ'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>

      <div className="container">
        {/* Header */}
        <header className="header">
          <div className="header-logo" aria-hidden="true">📄</div>
          <h1>Document Downloader</h1>
          <p>Download documents as PDF from Scribd and SlideShare, or save podcast episodes from Everand.</p>

          <div className="platforms" aria-label="Supported platforms">
            <span className="platform-badge scribd">📕 Scribd</span>
            <span className="platform-badge slide">📊 SlideShare</span>
            <span className="platform-badge everand">🎧 Everand</span>
          </div>
        </header>

        {/* URL Input */}
        <section className="card url-form" aria-label="Download form">
          <p className="card-title">Enter URL</p>
          <form onSubmit={handleSubmit}>
            <div className="input-row">
              <input
                className="url-input"
                type="url"
                value={url}
                onChange={e => { setUrl(e.target.value); setFormError(''); }}
                placeholder="https://www.scribd.com/document/… or slideshare.net/…"
                disabled={submitting}
                aria-label="Document URL"
                autoComplete="off"
                spellCheck="false"
              />
              <button
                className="btn btn-primary"
                type="submit"
                disabled={submitting || !url.trim()}
              >
                {submitting ? (
                  <><span className="spinner" aria-hidden="true" />Starting…</>
                ) : (
                  <>⬇ Download</>
                )}
              </button>
            </div>

            {formError && (
              <div className="error-banner" role="alert">
                <span aria-hidden="true">⚠</span>
                <span>{formError}</span>
              </div>
            )}
          </form>
        </section>

        {/* Active Downloads */}
        <section className="section" aria-label="Active downloads">
          <div className="section-header">
            <h2 className="section-title">
              Active Downloads
              {activeJobs.length > 0 && (
                <span className="badge">{activeJobs.length}</span>
              )}
            </h2>
          </div>

          {activeJobs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">⏸</div>
              <p>No active downloads. Submit a URL above to start.</p>
            </div>
          ) : (
            activeJobs.map(job => (
              <JobCard key={job.id} job={job} />
            ))
          )}
        </section>

        {/* History */}
        {doneJobs.length > 0 && (
          <section className="section" aria-label="Download history">
            <div className="section-header">
              <h2 className="section-title">
                History
                <span className="badge">{doneJobs.length}</span>
              </h2>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setJobs(prev => prev.filter(j => j.status === 'pending' || j.status === 'processing'))}
              >
                Clear
              </button>
            </div>

            {doneJobs.map(job => (
              <JobCard key={job.id} job={job} />
            ))}
          </section>
        )}
      </div>
    </>
  );
}

// ─── JobCard sub-component ────────────────────────────────────────
function JobCard({ job }) {
  const platform = detectPlatform(job.url);
  const isActive = job.status === 'pending' || job.status === 'processing';

  return (
    <article className={`job-card status-${job.status}`} aria-label={`Download job: ${job.url}`}>
      <div className="job-header">
        <div className="job-meta">
          <div className="job-url" title={job.url}>{job.url}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <span className={`platform-tag ${platform}`}>{platformLabel(platform)}</span>
            <span className={`job-status-label ${job.status}`}>
              <span className={`status-dot ${job.status}`} aria-hidden="true" />
              {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
            </span>
          </div>
        </div>

        {job.status === 'completed' && (
          <a
            href={`/api/download?jobId=${job.id}`}
            download={job.filename}
            className="btn btn-success"
            aria-label={`Download ${job.filename}`}
          >
            ⬇ Save
          </a>
        )}
      </div>

      {/* Message */}
      <p className="job-message">{job.message}</p>

      {/* Progress bar — only when active or completed */}
      {(isActive || job.status === 'completed') && (
        <div style={{ marginBottom: '10px' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.78rem',
              color: 'var(--text-muted)',
              marginBottom: '6px',
            }}
          >
            <span>
              {job.totalPages > 0
                ? `Page ${job.currentPage} / ${job.totalPages}`
                : 'Processing…'}
            </span>
            <span style={{ fontWeight: 600 }}>{job.progress}%</span>
          </div>
          <div className="progress-wrap" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`progress-bar ${job.status === 'completed' ? 'complete' : ''}`}
              style={{ width: `${job.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="job-stats">
        {job.elapsedTime > 0 && (
          <span>⏱ {formatTime(job.elapsedTime)}</span>
        )}
        {job.filename && (
          <span>📄 {job.filename}</span>
        )}
        {job.fileSize && (
          <span className="file-size">💾 {formatBytes(job.fileSize)}</span>
        )}
      </div>
    </article>
  );
}
