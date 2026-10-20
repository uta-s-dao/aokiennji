'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { openChat } from '@/components/ChatWidget';
import { api } from '@/components/api';
import type { PublicConfig } from '@/lib/contracts';
import { company } from '@/lib/company';
export default function ConsultationLinks({
  subject,
  chat = false,
}: {
  subject: string;
  chat?: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (chat)
      api<PublicConfig>('/api/config')
        .then((c) => setEnabled(c.flags.chat))
        .catch(() => {});
  }, [chat]);
  return (
    <div className="consultation-actions">
      <Link className="button primary" href={`/contact?subject=${encodeURIComponent(subject)}`}>
        この内容で相談する
      </Link>
      {chat && enabled && (
        <button
          className="button secondary"
          type="button"
          onClick={() => openChat(`${subject}について相談したい`)}
        >
          チャットで条件を整理する
        </button>
      )}
      <a className="phone-link" href={`tel:${company.phone}`}>
        電話 {company.phone}
      </a>
    </div>
  );
}
