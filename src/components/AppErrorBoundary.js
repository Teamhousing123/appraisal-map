import React from 'react';
import BrandLogo from './BrandLogo';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('Appraisal Map could not render.', error);
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="app-recovery" aria-labelledby="app-recovery-title">
        <BrandLogo className="app-recovery__logo" />
        <h1 id="app-recovery-title">This screen did not open</h1>
        <p>Your data has not been changed. Reload Appraisal Map to try again.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload app
        </button>
      </main>
    );
  }
}

export default AppErrorBoundary;
