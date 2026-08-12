import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default async function Layout({ params, children }: LayoutProps<'/[lang]'>) {
  const { lang } = await params;
  const options = baseOptions(lang);

  return (
    <HomeLayout
      {...options}
      nav={{
        ...options.nav,
        transparentMode: 'top',
      }}
    >
      {children}
    </HomeLayout>
  );
}
