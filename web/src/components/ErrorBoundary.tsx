import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps a crash from erasing the app.
 *
 * React unmounts the whole root when a render or an effect throws, which leaves
 * a blank page — no sidebar, no header, nothing to click, and no clue what went
 * wrong. A boundary turns that into a message and a way back, and puts the error
 * somewhere the user can read it out.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="stack" style={{ maxWidth: 620, margin: '64px auto', padding: 24 }}>
        <div className="error">Something broke: {this.state.error.message}</div>
        <p className="muted">
          Nothing you have studied is lost — reviews are saved as you grade them.
        </p>
        <div className="row" style={{ gap: 9 }}>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button
            className="forest quiet"
            onClick={() => {
              window.location.hash = '#/';
              window.location.reload();
            }}
          >
            Back to Today
          </button>
        </div>
      </div>
    );
  }
}
