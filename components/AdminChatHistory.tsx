'use client';
import { useEffect, useRef } from 'react';
import type { AiAnswer, ChatMessage } from '@/lib/contracts';
import { datetime } from './api';
import AdminAnswerDetails, { answerMethod } from './AdminAnswerDetails';

export default function AdminChatHistory({
  messages,
  answers = [],
  selectedAnswerId,
}: {
  messages: ChatMessage[];
  answers?: AiAnswer[];
  selectedAnswerId?: string;
}) {
  const selected = useRef<HTMLElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'start' });
  }, [selectedAnswerId]);
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  return (
    <div className="admin-chat-history" role="log" aria-label="チャットの会話履歴">
      {messages.map((message) => {
        const answer = byId.get(message.id);
        const isSelected = message.role === 'assistant' && message.id === selectedAnswerId;
        return (
          <article
            className={`chat-message ${message.role}${isSelected ? ' ai-usage-selected' : ''}`}
            key={message.id}
            ref={isSelected ? selected : undefined}
            aria-label={message.role === 'user' ? 'お客様のメッセージ' : 'チャットの返信'}
          >
            <small className="admin-chat-author">
              {message.role === 'user' ? 'お客様' : 'アオキエンジ（チャットの回答）'}
              {isSelected ? ' · 選択中の回答' : ''}
            </small>
            <p className="chat-bubble">{message.content}</p>
            <time className="admin-chat-time" dateTime={message.createdAt}>
              {datetime(message.createdAt)}
            </time>
            {message.incomplete && (
              <small className="admin-chat-incomplete">返信の途中（未完了）</small>
            )}
            {message.evidence?.map((e, i) => (
              <p className="admin-chat-reference" key={i}>
                参照：{e.title} {e.url}
              </p>
            ))}
            {answer && (
              <>
                {answerMethod(answer) && (
                  <p className="admin-answer-method">回答文の作成：{answerMethod(answer)}</p>
                )}
                <AdminAnswerDetails answer={answer} open={isSelected} />
              </>
            )}
          </article>
        );
      })}
    </div>
  );
}
