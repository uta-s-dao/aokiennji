import Image from 'next/image';
import type { SiteContent } from '@/lib/site-content';

export default function HeroSlider({ slides }: { slides: SiteContent['home']['slides'] }) {
  return (
    <div className="hero-slider" role="img" aria-label="アオキエンジの製作・施工実績">
      {slides.map((slide, index) => (
        <div className={`hero-slide hero-slide-${index + 1}`} aria-hidden="true" key={index}>
          <Image
            src={slide.image}
            unoptimized={slide.image.startsWith('/api/')}
            alt=""
            fill
            sizes="100vw"
            preload={index === 0}
          />
          <span>{slide.label}</span>
        </div>
      ))}
    </div>
  );
}
