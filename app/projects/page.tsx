'use client';
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';
import { projects } from '@/lib/company';
import SiteShell from '@/components/SiteShell';
const categories = ['すべて', ...Array.from(new Set(projects.map((p) => p.category)))];
export default function Projects() {
  const [category, setCategory] = useState('すべて');
  return (
    <SiteShell>
      <div className="page-hero">
        <div className="container">
          <p className="eyebrow">PROJECTS</p>
          <h1>製作実績</h1>
          <p>多様な産業設備に、確かな技術で応えます。</p>
        </div>
      </div>
      <section className="section">
        <div className="container">
          <div className="filter-pills" role="group" aria-label="実績カテゴリ">
            {categories.map((c) => (
              <button
                type="button"
                key={c}
                className={category === c ? 'active' : ''}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="project-grid">
            {projects
              .filter((p) => category === 'すべて' || p.category === category)
              .map((p) => (
                <article className="project-card" key={p.id}>
                  <div className="project-image">
                    <Image src={p.image} alt={p.name} fill sizes="(max-width: 760px) 100vw, 50vw" />
                  </div>
                  <div className="project-content">
                    <span>{p.category}</span>
                    <h2>{p.name}</h2>
                    <p>{p.description}</p>
                    <Link
                      href={`/contact?subject=${encodeURIComponent(p.name)}`}
                      className="text-link"
                    >
                      類似案件を相談する <ArrowUpRight size={17} />
                    </Link>
                  </div>
                </article>
              ))}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
