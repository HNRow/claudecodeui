type KimiLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Kimi Code. */
const KimiLogo = ({ className = 'w-5 h-5' }: KimiLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Kimi"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="2.5" y="2.5" width="19" height="19" rx="6" stroke="currentColor" strokeWidth="2" />
    <path
      d="M8.25 7v10M8.25 12.4 13 7.6M8.25 12.4 13.4 17"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="16.8" cy="8.2" r="1.35" fill="currentColor" />
  </svg>
);

export default KimiLogo;