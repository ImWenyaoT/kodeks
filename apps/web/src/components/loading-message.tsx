import React from "react";

// 渲染助手流式响应时的小圆点占位。
const LoadingMessage: React.FC = () => {
  return (
    <div className="kodeks-chat-text">
      <div className="flex flex-col">
        <div className="flex">
          <div className="mr-4 rounded-[16px] bg-white px-4 py-2 text-black dark:bg-zinc-950 dark:text-zinc-50 md:mr-24">
            <div className="h-3 w-3 animate-pulse rounded-full bg-black dark:bg-white" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoadingMessage;
