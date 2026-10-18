import React, { useEffect, useRef, useState } from 'react';
import {
  formatCopyableAddress,
  formatPrimaryFactsSummary,
} from '../domain/primaryFacts';
import { copyTextToClipboard } from '../services/clipboard';

const COPY_STATUS_CLEAR_MS = 4000;
const STATUS_MESSAGES = {
  unavailable: 'Copy is not available in this browser. Select the text and copy it manually.',
  denied: 'Clipboard access was denied. Select the text and copy it manually.',
  failed: 'Clipboard access was denied. Select the text and copy it manually.',
};

export function CopyActions({ report, compact = false, idPrefix }) {
  const [status, setStatus] = useState('');
  const statusTimerRef = useRef(null);

  useEffect(() => () => {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
  }, []);

  const showStatus = (message) => {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    setStatus(message);
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      setStatus('');
    }, COPY_STATUS_CLEAR_MS);
  };

  const copy = async (text, successMessage) => {
    const result = await copyTextToClipboard(text);
    showStatus(result.ok ? successMessage : STATUS_MESSAGES[result.reason] || STATUS_MESSAGES.failed);
  };

  const prefix = idPrefix ? `${idPrefix}-` : '';
  return (
    <div className={`copy-actions${compact ? ' copy-actions--compact' : ''}`}>
      <button
        type="button"
        id={`${prefix}copy-address`}
        className="button button--quiet"
        aria-label={`Copy address for ${report.address}`}
        onClick={() => copy(formatCopyableAddress(report), 'Address copied.')}
      >
        Copy address
      </button>
      {!compact && (
        <button
          type="button"
          id={`${prefix}copy-facts`}
          className="button button--quiet"
          aria-label={`Copy facts for ${report.address}`}
          onClick={() => copy(formatPrimaryFactsSummary(report), 'Facts copied.')}
        >
          Copy facts
        </button>
      )}
      {status && (
        <span role="status" className="copy-actions__status">
          {status}
        </span>
      )}
    </div>
  );
}

export default CopyActions;
