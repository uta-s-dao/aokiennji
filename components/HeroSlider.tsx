const slides = [
  { src: '/images/legacy/hero-01.jpg', label: '耐火物製品の製作実績' },
  { src: '/images/legacy/hero-02.jpg', label: '大型タンクの積込み作業' },
  { src: '/images/legacy/hero-03.jpg', label: '太陽光発電設備の施工実績' },
];

export default function HeroSlider() {
  return (
    <div className="hero-slider" role="img" aria-label="アオキエンジの製作・施工実績">
      {slides.map((slide, index) => (
        <div
          className={`hero-slide hero-slide-${index + 1}`}
          style={{ backgroundImage: `url(${slide.src})` }}
          aria-hidden="true"
          key={slide.src}
        >
          <span>{slide.label}</span>
        </div>
      ))}
    </div>
  );
}
