import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';

/** Mirrors the backend `KimiLoginStatus` returned by the provider login routes. */
type KimiLoginStatus = {
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  verificationUrl: string | null;
  userCode: string | null;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
};

type ApiEnvelope<T> = { success: boolean; data: T };

const POLL_INTERVAL_MS = 2_000;

type KimiDeviceLoginProps = {
  onComplete?: (exitCode: number) => void;
};

/**
 * Device-code login panel for Kimi Code CLI.
 *
 * Kimi owns the OAuth exchange; this panel starts `kimi login`, polls the
 * backend for the verification URL and user code it printed, and reports the
 * exit status so Settings/onboarding can refresh the provider auth state.
 * Closing the panel does not cancel the flow — the CLI finishes it in the
 * background and the next open picks the state back up.
 */
export default function KimiDeviceLogin({ onComplete }: KimiDeviceLoginProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<KimiLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const reportedSuccess = useRef(false);

  const readStatus = useCallback(async (): Promise<KimiLoginStatus | null> => {
    try {
      const response = await api.providers.loginStatus('kimi');
      const payload = await readApiJson<ApiEnvelope<KimiLoginStatus>>(response);
      return payload.data;
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError));
      return null;
    }
  }, []);

  const startLogin = useCallback(async () => {
    setStarting(true);
    setError(null);
    reportedSuccess.current = false;
    try {
      const response = await api.providers.startLogin('kimi');
      const payload = await readApiJson<ApiEnvelope<KimiLoginStatus>>(response);
      setStatus(payload.data);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setStarting(false);
    }
  }, []);

  // Pick up a login the previous session already started, otherwise begin one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await readStatus();
      if (cancelled) {
        return;
      }
      if (current?.state === 'running') {
        setStatus(current);
        return;
      }
      await startLogin();
    })();

    return () => {
      cancelled = true;
    };
  }, [readStatus, startLogin]);

  // Poll while the CLI process is alive.
  useEffect(() => {
    if (status?.state !== 'running') {
      return;
    }

    const timer = window.setInterval(() => {
      void readStatus().then((next) => {
        if (next) {
          setStatus(next);
        }
      });
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [readStatus, status?.state]);

  // Report the terminal outcome once.
  useEffect(() => {
    if (status?.state === 'succeeded' && !reportedSuccess.current) {
      reportedSuccess.current = true;
      onComplete?.(status.exitCode ?? 0);
    }
    if (status?.state === 'failed' && !reportedSuccess.current) {
      reportedSuccess.current = true;
      onComplete?.(status.exitCode ?? 1);
    }
  }, [onComplete, status]);

  const cancelLogin = async () => {
    try {
      const response = await api.providers.cancelLogin('kimi');
      const payload = await readApiJson<ApiEnvelope<KimiLoginStatus>>(response);
      setStatus(payload.data);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be denied; the value stays selectable in the UI.
    }
  };

  const state = status?.state ?? 'idle';

  return (
    <div className="flex flex-col gap-4 p-6">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t('settings:agents.kimiLogin.description', {
          defaultValue: 'Kimi Code CLI opens a device login. Open the link below and enter the code to authorize this machine.',
        })}
      </p>

      {status?.verificationUrl && (
        <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('settings:agents.kimiLogin.url', { defaultValue: 'Verification link' })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <a
              href={status.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="break-all text-sm text-blue-600 underline dark:text-blue-400"
            >
              {status.verificationUrl}
            </a>
            <button
              type="button"
              onClick={() => void copy(status.verificationUrl as string)}
              className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600"
            >
              {t('common:misc.copy', { defaultValue: 'Copy' })}
            </button>
          </div>
        </div>
      )}

      {status?.userCode && (
        <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('settings:agents.kimiLogin.code', { defaultValue: 'User code' })}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <code className="rounded bg-gray-100 px-3 py-1 font-mono text-lg tracking-widest dark:bg-gray-800">
              {status.userCode}
            </code>
            <button
              type="button"
              onClick={() => void copy(status.userCode as string)}
              className="shrink-0 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600"
            >
              {t('common:misc.copy', { defaultValue: 'Copy' })}
            </button>
          </div>
        </div>
      )}

      <div className="text-sm">
        {state === 'running' && (
          <span className="text-gray-600 dark:text-gray-300">
            {t('settings:agents.kimiLogin.waiting', { defaultValue: 'Waiting for authorization…' })}
          </span>
        )}
        {state === 'succeeded' && (
          <span className="text-green-600 dark:text-green-400">
            {t('settings:agents.kimiLogin.succeeded', { defaultValue: 'Logged in to Kimi Code CLI.' })}
          </span>
        )}
        {(state === 'failed' || state === 'timed_out' || state === 'cancelled') && (
          <span className="text-red-600 dark:text-red-400">
            {status?.message
              ?? t('settings:agents.kimiLogin.failed', { defaultValue: 'Kimi login did not complete.' })}
          </span>
        )}
      </div>

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      <div className="flex gap-2">
        {state === 'running' ? (
          <button
            type="button"
            onClick={() => void cancelLogin()}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
          >
            {t('common:misc.cancel', { defaultValue: 'Cancel' })}
          </button>
        ) : (
          <button
            type="button"
            disabled={starting}
            onClick={() => void startLogin()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {t('settings:agents.kimiLogin.retry', { defaultValue: 'Start login again' })}
          </button>
        )}
      </div>
    </div>
  );
}