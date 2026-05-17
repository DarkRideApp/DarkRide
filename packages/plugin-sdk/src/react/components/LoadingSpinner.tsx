interface LoadingSpinnerProps {
  large?: boolean;
  center?: boolean;
}

export function LoadingSpinner({ large, center }: LoadingSpinnerProps) {
  const spinner = <div className={`spinner ${large ? 'spinner-lg' : ''}`} data-testid="loading-spinner" />;
  if (center) {
    return <div className="loading-center">{spinner}</div>;
  }
  return spinner;
}
