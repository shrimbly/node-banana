import React, { ReactNode } from "react";
import { cn } from "./cn";
import { SOCKET_PITCH, SOCKET_TOP } from "./tokens";
import { CARD_EDGE } from "@/utils/nodeDimensions";

/**
 * Rows for logic nodes, laid out at the socket pitch so row `i` is centred on
 * socket `i`. The first socket sits SOCKET_TOP from the card's top edge and
 * the clip starts CARD_EDGE below it, so the rows begin with a small offset.
 */
export function LogicRows({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("flex flex-col pb-1", className)}
      style={{ paddingTop: SOCKET_TOP - CARD_EDGE - SOCKET_PITCH / 2 }}
    >
      {children}
    </div>
  );
}

export function LogicRow({
  children,
  className,
  well = false,
  ...rest
}: { children: ReactNode; className?: string; well?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("flex items-center gap-1.5 px-2 shrink-0 min-w-0", className)}
      style={{ height: SOCKET_PITCH, ...rest.style }}
    >
      {well ? (
        // An inset lane, so each row reads as its own item rather than a line of text.
        <div className="flex-1 min-w-0 h-[22px] flex items-center gap-1.5 px-[7px] rounded-well squircle bg-well shadow-well">
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
