'use client';

import { useState, type ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function PasswordInput({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, 'type'>) {
  const t = useTranslations('AuthFrame');
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        className={cn('pe-12', className)}
      />
      <button
        type="button"
        aria-label={t(visible ? 'hidePassword' : 'showPassword')}
        aria-controls={props.id}
        className="text-muted-foreground hover:text-foreground absolute inset-y-0 end-0 grid min-w-11 place-items-center rounded-e-lg transition-colors"
        onClick={() => setVisible((value) => !value)}
      >
        <Icon className="size-4.5" aria-hidden="true" />
      </button>
    </div>
  );
}
