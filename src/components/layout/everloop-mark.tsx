import Image from 'next/image';
import { cn } from '@/lib/utils';

export function EverloopMark({ className }: { className?: string }) {
  return <Image src="/everloop/mark.svg" width={48} height={48} alt="" className={cn('size-8 shrink-0', className)} unoptimized />;
}
