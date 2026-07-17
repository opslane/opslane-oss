import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureException } from './core';

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
}
interface State {
  error: Error | null;
}

/**
 * React render errors do not reach window.onerror — they need an error boundary.
 * Wrap your tree (or route subtrees) in <OpslaneErrorBoundary> to capture them.
 */
export class OpslaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    try {
      captureException(error);
    } catch {
      /* SDK must never throw */
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      return typeof fallback === 'function' ? fallback(error) : (fallback ?? null);
    }
    return this.props.children;
  }
}

/**
 * For Next.js app/global-error.tsx and error.tsx, which receive the error as a prop.
 * Pass the optional `componentStack` (from an error boundary's `ErrorInfo`) to
 * append React's component trace to the reported stack for easier triage.
 */
export function captureReactError(error: Error, componentStack?: string): void {
  try {
    if (componentStack) {
      error.stack = `${error.stack ?? ''}\n${componentStack}`;
    }
    captureException(error);
  } catch {
    /* SDK must never throw */
  }
}
