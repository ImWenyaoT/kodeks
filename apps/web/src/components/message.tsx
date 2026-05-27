import React from "react";
import ReactMarkdown from "react-markdown";

import type { TimelineMessageItem } from "@/lib/conversation-timeline";

type MessageProps = {
  message: TimelineMessageItem;
};

// 渲染聊天气泡，用户消息靠右，助手消息靠左。
const Message: React.FC<MessageProps> = ({ message }) => {
  return (
    <div className="text-sm">
      {message.role === "user" ? (
        <div className="flex justify-end">
          <div>
            <div className="ml-4 rounded-[16px] bg-[#ededed] px-4 py-2 font-light text-stone-900 dark:bg-zinc-800 dark:text-zinc-50 md:ml-24">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex">
            <div className="mr-4 rounded-[16px] bg-white px-4 py-2 font-light text-black dark:bg-zinc-950 dark:text-zinc-50 md:mr-24">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Message;
