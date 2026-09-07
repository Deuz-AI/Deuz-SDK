'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

// The only path to `three`: loaded on the client, after hydration, and only on the home page.
const MascotScene = dynamic(() => import('./mascot-scene'), { ssr: false });

type Props = {
  /** URL of the mascot GLB, or `null` to use the placeholder rig. */
  modelUrl: string | null;
  className?: string;
};

/**
 * The hero mascot. The server renders the PNG — it is the largest thing above the
 * fold and must not wait for JavaScript — and, once the hero scrolls into view on a
 * WebGL-capable browser that has not asked for reduced motion, the 3D scene mounts
 * over it and fades the drawing out on its first frame.
 *
 * `dark:invert` is load-bearing: the art is pure black on transparency and would
 * vanish on the black paper of dark mode without it.
 */
export function HeroMascot({ modelUrl, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof WebGL2RenderingContext === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setMounted(true);
        observer.disconnect();
      },
      { rootMargin: '200px' },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" className={cn('relative aspect-[760/864]', className)}>
      <img
        src="/mascot/deuz-mascot.png"
        alt=""
        width={760}
        height={864}
        fetchPriority="high"
        decoding="async"
        className={cn(
          'block size-full object-contain transition-opacity duration-300 dark:invert motion-reduce:transition-none lg:-scale-x-100',
          ready && 'opacity-0',
        )}
      />
      {mounted ? (
        <MascotScene
          modelUrl={modelUrl}
          onReady={() => setReady(true)}
          className="absolute inset-0"
        />
      ) : null}
    </div>
  );
}
