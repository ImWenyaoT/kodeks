import Assistant from '@/components/assistant';

// 渲染 Kodeks 的主工作台外壳。
export default function Main() {
  return (
    <div className="relative flex h-dvh min-h-0 justify-center overflow-hidden">
      <Assistant />
    </div>
  );
}
