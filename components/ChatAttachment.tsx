'use client';
import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from './api';

export default function ChatAttachment({ id, admin = false }: { id: string; admin?: boolean }) {
  const url = admin ? `/api/admin/chat-images/${id}` : `/api/chat/images/${id}`;
  const [metadata, setMetadata] = useState<{ fileName: string; contentType: string }>();
  useEffect(() => {
    let active = true;
    api<{ fileName: string; contentType: string }>(`${url}?metadata=1`)
      .then((value) => {
        if (active) setMetadata(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <a className="chat-attachment" href={url} target="_blank" rel="noreferrer">
      {metadata?.contentType.startsWith('image/') ? (
        <img
          className="chat-attached-image"
          src={url}
          alt={admin ? 'お客様の添付写真' : '添付した商品写真'}
        />
      ) : (
        <>
          <FileText size={20} aria-hidden="true" />
          <span>{metadata?.fileName || '添付ファイルを開く'}</span>
        </>
      )}
    </a>
  );
}
