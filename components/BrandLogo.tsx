import { company } from '@/lib/company';

/** The original emblem and live text can be sized and arranged independently. */
export function BrandMark() {
  return (
    <svg className="brand-emblem" viewBox="32 26 47 47" aria-hidden="true" focusable="false">
      {/* Keep the original artwork; show only its emblem, without the wordmark/address. */}
      <image href="/images/legacy/header-logo.png" width="968" height="109" />
    </svg>
  );
}

export default function BrandLogo({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  return (
    <span className={`brand-identity brand-identity-${tone}`}>
      <BrandMark />
      <span className="brand-identity-words">
        <span className="brand-identity-name">{company.name}</span>
        <span className="brand-identity-english" lang="en">
          {company.englishName}
        </span>
      </span>
    </span>
  );
}
