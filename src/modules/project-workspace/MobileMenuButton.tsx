import { useTranslation } from 'react-i18next';
import { useMobileMenuHandlers } from '@/modules/project-workspace/hooks/useMobileMenuHandlers';

type MobileMenuButtonProps = {
  onMenuClick: () => void;
  compact?: boolean;
};

/** Rendered by WorkspaceHeader and WorkspaceStateView to open the sidebar drawer on mobile. */
export default function MobileMenuButton({ onMenuClick, compact = false }: MobileMenuButtonProps) {
  const { t } = useTranslation();
  const { handleMobileMenuClick, handleMobileMenuTouchEnd } = useMobileMenuHandlers(onMenuClick);

  // The mobile header's only navigation control: keep a 44 px tap target.
  const touchTargetClasses = 'max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center';
  const buttonClasses = compact
    ? `p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 pwa-menu-button ${touchTargetClasses}`
    : `p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 touch-manipulation active:scale-95 pwa-menu-button flex-shrink-0 ${touchTargetClasses}`;

  return (
    <button
      onClick={handleMobileMenuClick}
      onTouchEnd={handleMobileMenuTouchEnd}
      className={buttonClasses}
      aria-label={t('misc.openMenu')}
    >
      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}
