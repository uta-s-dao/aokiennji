import Link from 'next/link';
import StructuredData from '@/components/StructuredData';
import { siteOrigin } from '@/lib/seo';
export default function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <>
      <nav className="breadcrumbs container" aria-label="パンくずリスト">
        <ol>
          {items.map((item, i) => (
            <li key={item.path}>
              {i === items.length - 1 ? (
                <span aria-current="page">{item.name}</span>
              ) : (
                <Link href={item.path}>{item.name}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <StructuredData
        data={{
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: items.map((item, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: item.name,
            item: `${siteOrigin()}${item.path}`,
          })),
        }}
      />
    </>
  );
}
