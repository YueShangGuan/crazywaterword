// src/ui/console.tsx
import * as React11 from "react";
import { renderToStaticMarkup as renderToStaticMarkup3 } from "react-dom/server";

// src/ui/button.tsx
import * as React from "react";
import { cva } from "class-variance-authority";

// src/ui/utils.ts
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// src/ui/button.tsx
import * as Slot from "@radix-ui/react-slot";
var buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline: "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);
function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}) {
  const Comp = asChild ? Slot.Root : "button";
  return /* @__PURE__ */ React.createElement(
    Comp,
    {
      "data-slot": "button",
      "data-variant": variant,
      "data-size": size,
      className: cn(buttonVariants({ variant, size, className })),
      ...props
    }
  );
}

// src/ui/card.tsx
import * as React2 from "react";
function Card({ className, ...props }) {
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      "data-slot": "card",
      className: cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm",
        className
      ),
      ...props
    }
  );
}
function CardHeader({ className, ...props }) {
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      "data-slot": "card-header",
      className: cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      ),
      ...props
    }
  );
}
function CardTitle({ className, ...props }) {
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      "data-slot": "card-title",
      className: cn("leading-none font-semibold", className),
      ...props
    }
  );
}
function CardDescription({ className, ...props }) {
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      "data-slot": "card-description",
      className: cn("text-sm text-muted-foreground", className),
      ...props
    }
  );
}
function CardContent({ className, ...props }) {
  return /* @__PURE__ */ React2.createElement(
    "div",
    {
      "data-slot": "card-content",
      className: cn("px-6", className),
      ...props
    }
  );
}

// src/ui/input.tsx
import * as React3 from "react";
function Input({ className, type, ...props }) {
  return /* @__PURE__ */ React3.createElement(
    "input",
    {
      type,
      "data-slot": "input",
      className: cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      ),
      ...props
    }
  );
}

// src/ui/switch.tsx
import * as React4 from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
function Switch({
  className,
  size = "default",
  ...props
}) {
  return /* @__PURE__ */ React4.createElement(
    SwitchPrimitive.Root,
    {
      "data-slot": "switch",
      "data-size": size,
      className: cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-[1.15rem] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        className
      ),
      ...props
    },
    /* @__PURE__ */ React4.createElement(
      SwitchPrimitive.Thumb,
      {
        "data-slot": "switch-thumb",
        className: cn(
          "pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0 dark:data-[state=checked]:bg-primary-foreground dark:data-[state=unchecked]:bg-foreground"
        )
      }
    )
  );
}

// src/ui/layout.tsx
import * as React9 from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Compass, LayoutDashboard, Timer, Hand, Flag, Swords, CalendarDays, ContactRound, Gift, ScrollText, X } from "lucide-react";

// src/ui/badge.tsx
import * as React5 from "react";
import { cva as cva2 } from "class-variance-authority";
import * as Slot2 from "@radix-ui/react-slot";
var badgeVariants = cva2(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive: "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline: "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);
function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}) {
  const Comp = asChild ? Slot2.Root : "span";
  return /* @__PURE__ */ React5.createElement(
    Comp,
    {
      "data-slot": "badge",
      "data-variant": variant,
      className: cn(badgeVariants({ variant }), className),
      ...props
    }
  );
}

// src/ui/native-select.tsx
import * as React6 from "react";
import { ChevronDownIcon } from "lucide-react";
function NativeSelect({
  className,
  size = "default",
  ...props
}) {
  return /* @__PURE__ */ React6.createElement(
    "div",
    {
      className: "group/native-select relative w-fit has-[select:disabled]:opacity-50",
      "data-slot": "native-select-wrapper"
    },
    /* @__PURE__ */ React6.createElement(
      "select",
      {
        "data-slot": "native-select",
        "data-size": size,
        className: cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 data-[size=sm]:py-1 dark:bg-input/30 dark:hover:bg-input/50",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          className
        ),
        ...props
      }
    ),
    /* @__PURE__ */ React6.createElement(
      ChevronDownIcon,
      {
        className: "pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none",
        "aria-hidden": "true",
        "data-slot": "native-select-icon"
      }
    )
  );
}

// src/ui/checkbox.tsx
import * as React7 from "react";
import { CheckIcon } from "lucide-react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
function Checkbox({
  className,
  ...props
}) {
  return /* @__PURE__ */ React7.createElement(
    CheckboxPrimitive.Root,
    {
      "data-slot": "checkbox",
      className: cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary",
        className
      ),
      ...props
    },
    /* @__PURE__ */ React7.createElement(
      CheckboxPrimitive.Indicator,
      {
        "data-slot": "checkbox-indicator",
        className: "grid place-content-center text-current transition-none"
      },
      /* @__PURE__ */ React7.createElement(CheckIcon, { className: "size-3.5" })
    )
  );
}

// src/ui/table.tsx
import * as React8 from "react";
function Table({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "div",
    {
      "data-slot": "table-container",
      className: "relative w-full overflow-x-auto"
    },
    /* @__PURE__ */ React8.createElement(
      "table",
      {
        "data-slot": "table",
        className: cn("w-full caption-bottom text-sm", className),
        ...props
      }
    )
  );
}
function TableHeader({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "thead",
    {
      "data-slot": "table-header",
      className: cn("[&_tr]:border-b", className),
      ...props
    }
  );
}
function TableBody({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "tbody",
    {
      "data-slot": "table-body",
      className: cn("[&_tr:last-child]:border-0", className),
      ...props
    }
  );
}
function TableRow({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "tr",
    {
      "data-slot": "table-row",
      className: cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      ),
      ...props
    }
  );
}
function TableHead({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "th",
    {
      "data-slot": "table-head",
      className: cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      ),
      ...props
    }
  );
}
function TableCell({ className, ...props }) {
  return /* @__PURE__ */ React8.createElement(
    "td",
    {
      "data-slot": "table-cell",
      className: cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      ),
      ...props
    }
  );
}

// src/ui/layout.tsx
var navGroups = [
  ["\u6982\u89C8", [["overview", "\u603B\u89C8", "icon_btn_bottom_home", LayoutDashboard], ["idle", "\u6302\u673A", "icon_btn_offline", Timer]]],
  ["\u64CD\u4F5C", [
    ["manual", "\u5355\u6B21\u64CD\u4F5C", "icon_btn_bottom_bag", Hand],
    ["stages", "\u6311\u6218", "icon_btn_bottom_battle", Flag],
    ["heroes", "\u82F1\u96C4", "icon_btn_bottom_hero", Swords],
    ["dailies", "\u65E5\u5E38", "icon_btn_star", CalendarDays],
    ["activities", "\u6D3B\u52A8", "icon_activity_week_month", Gift]
  ]],
  ["\u7BA1\u7406", [["account", "\u8D26\u53F7", "icon_btn_moreFunc", ContactRound]]]
];
function GameIcon({ sprite, size, children }) {
  if (!sprite) return children;
  const { url, x, y, w, h, rotated } = sprite;
  const scale = size / Math.max(w, h);
  return /* @__PURE__ */ React9.createElement("span", { "aria-hidden": "true", style: {
    position: "relative",
    display: "inline-block",
    flexShrink: 0,
    width: w * scale,
    height: h * scale,
    overflow: "hidden"
  } }, /* @__PURE__ */ React9.createElement("span", { style: {
    position: "absolute",
    top: 0,
    left: 0,
    width: rotated ? h : w,
    height: rotated ? w : h,
    background: `url("${url}") ${-x}px ${-y}px no-repeat`,
    transformOrigin: "0 0",
    transform: rotated ? `translateY(${h * scale}px) rotate(-90deg) scale(${scale})` : `scale(${scale})`
  } }));
}
function rail(icon) {
  return renderToStaticMarkup(/* @__PURE__ */ React9.createElement("aside", { className: "rail" }, /* @__PURE__ */ React9.createElement("div", { className: "mast" }, /* @__PURE__ */ React9.createElement("span", { className: "mast-icon" }, /* @__PURE__ */ React9.createElement(GameIcon, { sprite: icon("icon_sail"), size: 26 }, /* @__PURE__ */ React9.createElement(Compass, { className: "bearing", "aria-hidden": "true" }))), /* @__PURE__ */ React9.createElement("div", null, /* @__PURE__ */ React9.createElement("h1", null, "\u75AF\u72C2\u6C34\u4E16\u754C"), /* @__PURE__ */ React9.createElement("span", { className: "brand-label" }, "\u822A\u884C\u63A7\u5236\u53F0"))), /* @__PURE__ */ React9.createElement("nav", { id: "tabs", "aria-label": "\u529F\u80FD\u5BFC\u822A" }, navGroups.map(([group, items]) => /* @__PURE__ */ React9.createElement("div", { className: "nav-group", key: group }, /* @__PURE__ */ React9.createElement("span", { className: "nav-label" }, group), items.map(([key, title, name, Icon]) => /* @__PURE__ */ React9.createElement(Button, { key, "data-tab": key, "aria-current": key === "overview" ? "page" : void 0, variant: "ghost" }, /* @__PURE__ */ React9.createElement(GameIcon, { sprite: icon(name), size: 22 }, /* @__PURE__ */ React9.createElement(Icon, { "aria-hidden": "true" })), title)))))));
}
function topbar() {
  return renderToStaticMarkup(/* @__PURE__ */ React9.createElement("header", { className: "topbar" }, /* @__PURE__ */ React9.createElement("h2", { id: "page-title" }, "\u603B\u89C8"), /* @__PURE__ */ React9.createElement("div", { className: "connection" }, /* @__PURE__ */ React9.createElement("span", { id: "hint", className: "warn" }), /* @__PURE__ */ React9.createElement("label", { className: "account-label", htmlFor: "account" }, "\u5F53\u524D\u8D26\u53F7"), /* @__PURE__ */ React9.createElement(NativeSelect, { id: "account", title: "\u9009\u62E9\u8D26\u53F7" }), /* @__PURE__ */ React9.createElement("span", { id: "busy", className: "status-pill", "data-state": "off", role: "status" }), /* @__PURE__ */ React9.createElement(Button, { id: "connect", size: "sm" }, "\u8FDE\u63A5"), /* @__PURE__ */ React9.createElement(Button, { id: "disconnect", size: "sm", variant: "outline" }, "\u65AD\u5F00"), /* @__PURE__ */ React9.createElement(Button, { id: "account-pause", size: "sm", variant: "outline", title: "\u6682\u505C\u540E\u65AD\u5F00\u6E38\u620F\u8FDE\u63A5\uFF0C\u65B9\u4FBF\u81EA\u884C\u4E0A\u53F7" }, "\u6682\u505C\u6258\u7BA1"), /* @__PURE__ */ React9.createElement(Button, { id: "log-toggle", size: "sm", variant: "outline", "aria-controls": "journal", "aria-expanded": "false" }, /* @__PURE__ */ React9.createElement(ScrollText, { "aria-hidden": "true" }), "\u65E5\u5FD7", /* @__PURE__ */ React9.createElement("span", { id: "log-toggle-count", className: "log-toggle-count", hidden: true })))));
}
function journal() {
  return renderToStaticMarkup(/* @__PURE__ */ React9.createElement("aside", { id: "journal", "aria-label": "\u8FD0\u884C\u65E5\u5FD7" }, /* @__PURE__ */ React9.createElement(Card, null, /* @__PURE__ */ React9.createElement(CardHeader, null, /* @__PURE__ */ React9.createElement("div", { className: "journal-top" }, /* @__PURE__ */ React9.createElement(CardTitle, null, "\u8FD0\u884C\u65E5\u5FD7"), /* @__PURE__ */ React9.createElement(Badge, { id: "log-count" }, "0"), /* @__PURE__ */ React9.createElement(Button, { id: "log-close", size: "icon-sm", variant: "ghost", "aria-label": "\u6536\u8D77\u65E5\u5FD7", title: "\u6536\u8D77\u65E5\u5FD7" }, /* @__PURE__ */ React9.createElement(X, { "aria-hidden": "true" })))), /* @__PURE__ */ React9.createElement(CardContent, null, /* @__PURE__ */ React9.createElement("div", { className: "log-filter", role: "group", "aria-label": "\u65E5\u5FD7\u7B5B\u9009" }, /* @__PURE__ */ React9.createElement(Button, { id: "log-all", size: "sm", variant: "outline", "aria-pressed": "true" }, "\u5168\u90E8"), /* @__PURE__ */ React9.createElement(Button, { id: "log-issues", size: "sm", variant: "outline", "aria-pressed": "false" }, "\u8B66\u544A\u4E0E\u9519\u8BEF")), /* @__PURE__ */ React9.createElement("div", { id: "log", role: "log", "aria-live": "polite", "aria-label": "\u64CD\u4F5C\u8BB0\u5F55" }), /* @__PURE__ */ React9.createElement("p", { id: "log-empty" }, "\u8FD8\u6CA1\u6709\u8FD0\u884C\u8BB0\u5F55")))));
}
function dialogs() {
  return renderToStaticMarkup(/* @__PURE__ */ React9.createElement(React9.Fragment, null, /* @__PURE__ */ React9.createElement("dialog", { id: "modal", "aria-labelledby": "m-title" }, /* @__PURE__ */ React9.createElement(Card, null, /* @__PURE__ */ React9.createElement(CardHeader, null, /* @__PURE__ */ React9.createElement(CardTitle, { id: "m-title" })), /* @__PURE__ */ React9.createElement(CardContent, null, /* @__PURE__ */ React9.createElement("div", { id: "m-body" }), /* @__PURE__ */ React9.createElement("div", { className: "bar" }, /* @__PURE__ */ React9.createElement(Checkbox, { id: "m-ack", className: "p-0" }), /* @__PURE__ */ React9.createElement("label", { htmlFor: "m-ack" }, "\u6211\u5DF2\u6838\u5BF9\u5F53\u524D\u8D26\u53F7\u548C\u672C\u6B21\u64CD\u4F5C")), /* @__PURE__ */ React9.createElement("div", { className: "bar" }, /* @__PURE__ */ React9.createElement(Button, { id: "m-ok", disabled: true }, "\u786E\u8BA4"), /* @__PURE__ */ React9.createElement(Button, { id: "m-cancel", variant: "outline" }, "\u53D6\u6D88"), /* @__PURE__ */ React9.createElement("span", { id: "m-count", className: "dim" }))))), /* @__PURE__ */ React9.createElement("dialog", { id: "account-dialog", "aria-labelledby": "account-title" }, /* @__PURE__ */ React9.createElement("form", { method: "dialog" }, /* @__PURE__ */ React9.createElement(Card, null, /* @__PURE__ */ React9.createElement(CardHeader, null, /* @__PURE__ */ React9.createElement(CardTitle, { id: "account-title" })), /* @__PURE__ */ React9.createElement(CardContent, null, /* @__PURE__ */ React9.createElement("p", { id: "account-message" }), /* @__PURE__ */ React9.createElement(Input, { id: "account-label-input", "aria-label": "\u8D26\u53F7\u5907\u6CE8" }), /* @__PURE__ */ React9.createElement("div", { className: "bar" }, /* @__PURE__ */ React9.createElement(Button, { value: "ok" }, "\u786E\u8BA4"), /* @__PURE__ */ React9.createElement(Button, { value: "cancel", variant: "outline" }, "\u53D6\u6D88"))))))));
}
function templates() {
  return renderToStaticMarkup(/* @__PURE__ */ React9.createElement(React9.Fragment, null, /* @__PURE__ */ React9.createElement("template", { id: "ui-table" }, /* @__PURE__ */ React9.createElement(Table, null, /* @__PURE__ */ React9.createElement(TableHeader, null, /* @__PURE__ */ React9.createElement(TableRow, null, /* @__PURE__ */ React9.createElement(TableHead, null))), /* @__PURE__ */ React9.createElement(TableBody, null, /* @__PURE__ */ React9.createElement(TableRow, null, /* @__PURE__ */ React9.createElement(TableCell, null))))), /* @__PURE__ */ React9.createElement("template", { id: "ui-button" }, /* @__PURE__ */ React9.createElement(Button, { variant: "outline", size: "sm" })), /* @__PURE__ */ React9.createElement("template", { id: "ui-select" }, /* @__PURE__ */ React9.createElement(NativeSelect, { size: "sm" })), /* @__PURE__ */ React9.createElement("template", { id: "ui-delete" }, /* @__PURE__ */ React9.createElement(Button, { variant: "destructive", size: "sm" })), /* @__PURE__ */ React9.createElement("template", { id: "ui-badge" }, /* @__PURE__ */ React9.createElement(Badge, { variant: "outline" })), /* @__PURE__ */ React9.createElement("template", { id: "ui-number" }, /* @__PURE__ */ React9.createElement(Input, { type: "number", className: "w-20" }))));
}

// src/ui/pages.tsx
import * as React10 from "react";
import { renderToStaticMarkup as renderToStaticMarkup2 } from "react-dom/server";
function Panel({ title, children }) {
  return /* @__PURE__ */ React10.createElement(Card, null, /* @__PURE__ */ React10.createElement(CardHeader, null, /* @__PURE__ */ React10.createElement(CardTitle, null, title)), /* @__PURE__ */ React10.createElement(CardContent, null, children));
}
function Option({ id, label, checked = false }) {
  return /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Switch, { id, "data-local-switch": "", defaultChecked: checked, className: "p-0" }), /* @__PURE__ */ React10.createElement("label", { htmlFor: id }, label));
}
function SubTabs({ name, label, items }) {
  const tabId = (id) => "subtab-" + name + "-" + id;
  const panelId = (id) => "subpanel-" + name + "-" + id;
  return /* @__PURE__ */ React10.createElement("div", { "data-subtabs": name }, /* @__PURE__ */ React10.createElement("div", { className: "subtabs", role: "tablist", "aria-label": label }, items.map((item, index) => /* @__PURE__ */ React10.createElement(
    "button",
    {
      key: item.id,
      type: "button",
      role: "tab",
      id: tabId(item.id),
      "aria-controls": panelId(item.id),
      "aria-selected": index === 0,
      tabIndex: index === 0 ? 0 : -1
    },
    item.title
  ))), items.map((item, index) => /* @__PURE__ */ React10.createElement(
    "section",
    {
      key: item.id,
      id: panelId(item.id),
      role: "tabpanel",
      "aria-labelledby": tabId(item.id),
      className: "grid gap-4",
      hidden: index !== 0
    },
    item.content
  )));
}
function overviewPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement("div", { className: "grid gap-4" }, /* @__PURE__ */ React10.createElement(Panel, { title: "\u89D2\u8272\u6982\u51B5" }, /* @__PURE__ */ React10.createElement("div", { className: "who", id: "who" }, /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u8FD8\u6CA1\u8FDE\u4E0A\u3002\u70B9\u9876\u90E8\u7684\u300C\u8FDE\u63A5\u300D\uFF0C\u6216\u5148\u53BB\u300C\u8D26\u53F7\u300D\u9875\u6DFB\u52A0\u8D26\u53F7\u3002")), /* @__PURE__ */ React10.createElement("div", { className: "overview-meta" }, /* @__PURE__ */ React10.createElement("span", { id: "overview-updated", className: "dim", role: "status" }), /* @__PURE__ */ React10.createElement(Button, { id: "overview-refresh", variant: "outline", size: "sm", disabled: true }, "\u7ACB\u5373\u5237\u65B0"))), /* @__PURE__ */ React10.createElement(Panel, { title: "\u8D44\u6E90" }, /* @__PURE__ */ React10.createElement("div", { className: "icons", id: "res" }, /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u8FDE\u63A5\u540E\u663E\u793A"))), /* @__PURE__ */ React10.createElement(Panel, { title: "\u5E93\u5B58" }, /* @__PURE__ */ React10.createElement("div", { className: "icons", id: "items" }, /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u8FDE\u63A5\u540E\u663E\u793A"))), /* @__PURE__ */ React10.createElement(Panel, { title: "\u4E3B\u529B\u82F1\u96C4" }, /* @__PURE__ */ React10.createElement("div", { className: "icons", id: "hero-strip" }, /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u8FDE\u63A5\u540E\u663E\u793A")))));
}
function activitiesPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement("div", { className: "grid gap-4" }, /* @__PURE__ */ React10.createElement("div", { className: "activity-toolbar" }, /* @__PURE__ */ React10.createElement("p", { className: "dim" }, "\u9009\u62E9\u6D3B\u52A8\uFF0C\u5355\u72EC\u6267\u884C\u6216\u8BBE\u7F6E\u81EA\u52A8\u8FD0\u884C\u3002"), /* @__PURE__ */ React10.createElement(Button, { id: "activities-refresh", variant: "outline", size: "sm" }, "\u5237\u65B0\u6D3B\u52A8")), /* @__PURE__ */ React10.createElement("div", { id: "activities-status", className: "dim", role: "status" }), /* @__PURE__ */ React10.createElement("div", { className: "activity-shell" }, /* @__PURE__ */ React10.createElement("div", { id: "activity-tabs", className: "activity-tabs", role: "tablist", "aria-label": "\u9009\u62E9\u6D3B\u52A8" }), /* @__PURE__ */ React10.createElement("section", { id: "activity-panel", role: "tabpanel", tabIndex: 0, hidden: true }, /* @__PURE__ */ React10.createElement(Card, null, /* @__PURE__ */ React10.createElement(CardHeader, null, /* @__PURE__ */ React10.createElement("div", { className: "activity-heading" }, /* @__PURE__ */ React10.createElement(CardTitle, { id: "activity-title" }), /* @__PURE__ */ React10.createElement("span", { id: "activity-kind" })), /* @__PURE__ */ React10.createElement("p", { id: "activity-end", className: "dim" })), /* @__PURE__ */ React10.createElement(CardContent, { className: "activity-content" }, /* @__PURE__ */ React10.createElement("div", { id: "activity-pirates", hidden: true }, /* @__PURE__ */ React10.createElement("div", { id: "pirate-board-view", className: "pirate-board", "aria-live": "polite" })), /* @__PURE__ */ React10.createElement("div", { id: "activity-detail" }, /* @__PURE__ */ React10.createElement("div", { id: "activities-list", className: "activity-body" }), /* @__PURE__ */ React10.createElement("div", { id: "activities-order" })))))), /* @__PURE__ */ React10.createElement("template", { id: "ui-event-switch" }, /* @__PURE__ */ React10.createElement(Switch, { className: "p-0" }))));
}
function manualPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement(SubTabs, { name: "manual", label: "\u5355\u6B21\u64CD\u4F5C\u5206\u7C7B", items: [
    { id: "claim", title: "\u9886\u53D6", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u4E00\u952E\u9886\u53D6" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "loot-run", variant: "default" }, "\u9886\u53D6\u73B0\u5728\u80FD\u9886\u7684"), /* @__PURE__ */ React10.createElement("span", { id: "loot-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("p", { className: "dim" }, "\u9886\u53D6\u4E3B\u7EBF\u3001\u6210\u5C31\u3001\u90AE\u4EF6\u3001\u6302\u673A\u6536\u76CA\uFF0C\u4EE5\u53CA\u5DF2\u62E5\u6709\u82F1\u96C4\u7684\u6280\u80FD\u5C55\u793A\u9996\u9886\u5956\u52B1\u3002\u4E0D\u82B1\u94BB\u77F3\u3002\u7ED3\u679C\u89C1\u8FD0\u884C\u65E5\u5FD7\u3002")), /* @__PURE__ */ React10.createElement(Panel, { title: "\u4EFB\u52A1\u5956\u52B1" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "tasks-plan", variant: "outline" }, "\u68C0\u67E5\u53EF\u9886"), /* @__PURE__ */ React10.createElement(Button, { id: "tasks-run", variant: "default" }, "\u9886\u53D6\u4EFB\u52A1\u5956\u52B1"), /* @__PURE__ */ React10.createElement("span", { id: "tasks-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("p", { className: "dim" }, "\u4E3B\u7EBF\u3001\u652F\u7EBF\u3001\u6210\u5C31\u3001\u6BCF\u65E5\u8BA2\u5355\u6863\u4F4D\u3002\u7B97\u4E0D\u51FA\u76EE\u6807\u503C\u7684\u4F1A\u8DF3\u8FC7\u3002\u7ED3\u679C\u89C1\u8FD0\u884C\u65E5\u5FD7\u3002"))) },
    { id: "world", title: "\u6D77\u9762", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u6D77\u9762" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Option, { id: "world-speedup", label: "\u672C\u8F6E\u5141\u8BB8\u82B1\u52A0\u901F\u5668", checked: true }), /* @__PURE__ */ React10.createElement(Option, { id: "world-reroll", label: "\u672C\u8F6E\u62D2\u5355\u91CD\u5237" }), /* @__PURE__ */ React10.createElement(Button, { id: "world-plan", variant: "outline" }, "\u5237\u65B0\u6570\u636E"), /* @__PURE__ */ React10.createElement(Button, { id: "world-run", variant: "default" }, "\u6267\u884C\u4E00\u8F6E"), /* @__PURE__ */ React10.createElement("span", { id: "world-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("div", { className: "who world-summary", id: "world-summary" }), /* @__PURE__ */ React10.createElement("div", { id: "world-view", className: "world-plan" }, "\u6536\u6210\u54C1 \u2192 \u7AE3\u5DE5 \u2192 \u4EA4\u5355 \u2192 \u6309\u8BA2\u5355\u7F3A\u53E3\u6392\u4EA7 \u2192 \u4F59\u6599\u5347\u7EA7\u5EFA\u7B51\u3002"), /* @__PURE__ */ React10.createElement("div", { id: "world-factories" }), /* @__PURE__ */ React10.createElement("div", { id: "world-orders" }))) },
    { id: "stock", title: "\u4ED3\u5E93\u4E0E\u8D44\u6E90\u7530", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u4ED3\u5E93" }, /* @__PURE__ */ React10.createElement("div", { className: "icons", id: "world-stock" })), /* @__PURE__ */ React10.createElement(Panel, { title: "\u8D44\u6E90\u7530" }, /* @__PURE__ */ React10.createElement("pre", { id: "world-fields" }))) }
  ] }));
}
function heroesPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement(SubTabs, { name: "heroes", label: "\u82F1\u96C4\u529F\u80FD\u5206\u7C7B", items: [
    { id: "growth", title: "\u517B\u6210", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u82F1\u96C4\u517B\u6210" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "hero-plan", variant: "outline" }, "\u8BA1\u7B97\u8BA1\u5212"), /* @__PURE__ */ React10.createElement(Button, { id: "hero-run", variant: "default" }, "\u6267\u884C\u517B\u6210"), /* @__PURE__ */ React10.createElement("span", { id: "hero-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("p", { className: "dim" }, "\u5347\u7EA7\u3001\u5347\u661F\u3001\u5347\u6280\u80FD\u7684\u6761\u4EF6\u53D6\u81EA\u6E38\u620F\u5BA2\u6237\u7AEF\u7684\u7EA2\u70B9\u903B\u8F91\uFF1B\u6267\u884C\u524D\u4F1A\u5148\u7B97\u4E00\u904D\u8BA1\u5212\u3002\u7ED3\u679C\u89C1\u8FD0\u884C\u65E5\u5FD7\u3002"), /* @__PURE__ */ React10.createElement("div", { id: "hero-table" }))) },
    { id: "appoint", title: "\u4EFB\u547D", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u82F1\u96C4\u4EFB\u547D" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "appoint-view", variant: "outline" }, "\u67E5\u770B\u804C\u4F4D"), /* @__PURE__ */ React10.createElement(Button, { id: "appoint-run", variant: "default" }, "\u4E00\u952E\u4EFB\u547D")), /* @__PURE__ */ React10.createElement("div", { id: "appoint-table", className: "dim" }, "\u6309\u6E38\u620F\u5185\u7684\u804C\u4F4D\u4F18\u5148\u987A\u5E8F\u81EA\u52A8\u5206\u914D\u82F1\u96C4\uFF0C\u5DF2\u6709\u4EFB\u547D\u53EF\u80FD\u8C03\u6574\u3002"))) },
    { id: "equipment", title: "\u88C5\u5907", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u82F1\u96C4\u88C5\u5907" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "equipment-refresh", variant: "outline" }, "\u5237\u65B0\u88C5\u5907")), /* @__PURE__ */ React10.createElement("div", { id: "equipment-view", className: "progression-view", "aria-live": "polite" }))) },
    { id: "crafting", title: "\u5236\u9020", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u88C5\u5907\u5236\u9020" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "crafting-refresh", variant: "outline" }, "\u5237\u65B0\u88C5\u5907\u5382")), /* @__PURE__ */ React10.createElement("div", { id: "crafting-view", className: "progression-view", "aria-live": "polite" }))) },
    { id: "lineup", title: "\u9635\u5BB9", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u63A8\u8350\u9635\u5BB9" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "lineup-refresh", variant: "outline" }, "\u5237\u65B0\u63A8\u8350")), /* @__PURE__ */ React10.createElement("div", { id: "lineup-view", className: "progression-view", "aria-live": "polite" }))) }
  ] }));
}
function dailiesPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement("div", { className: "grid gap-4" }, /* @__PURE__ */ React10.createElement(Panel, { title: "\u6BCF\u65E5\u4EFB\u52A1" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "dailies-plan", variant: "outline" }, "\u63A2\u6D4B"), /* @__PURE__ */ React10.createElement(Button, { id: "dailies-run", variant: "default" }, "\u4E00\u952E\u5B8C\u6210"), /* @__PURE__ */ React10.createElement(Option, { id: "dailies-paid", label: "\u5141\u8BB8\u82B1\u94BB\u77F3\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09" }), /* @__PURE__ */ React10.createElement("span", { id: "dailies-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("p", { className: "dim" }, "\u5148\u300C\u63A2\u6D4B\u300D\u770B\u770B\u73B0\u5728\u80FD\u505A\u54EA\u4E9B\u3001\u4E3A\u4EC0\u4E48\u4E0D\u80FD\u505A\u3002\u70B9\u91D1\u4E0E\u6298\u6263\u5E97\u9ED8\u8BA4\u8DF3\u8FC7\uFF0C\u52FE\u4E0A\u624D\u4F1A\u82B1\u94BB\u77F3\u3002\u7ED3\u679C\u89C1\u8FD0\u884C\u65E5\u5FD7\u3002"), /* @__PURE__ */ React10.createElement("div", { id: "dailies-table" })), /* @__PURE__ */ React10.createElement(Panel, { title: "\u8054\u76DF" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "guild-refresh", variant: "outline" }, "\u5237\u65B0\u8054\u76DF")), /* @__PURE__ */ React10.createElement("div", { id: "guild-view", className: "progression-view", "aria-live": "polite" }))));
}
function accountPage() {
  return renderToStaticMarkup2(/* @__PURE__ */ React10.createElement(SubTabs, { name: "account", label: "\u8D26\u53F7\u529F\u80FD\u5206\u7C7B", items: [
    { id: "list", title: "\u8D26\u53F7", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u8D26\u53F7" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "export-accounts", variant: "outline" }, "\u5BFC\u51FA\u5168\u90E8\u8D26\u53F7"), /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u5907\u4EFD\u542B\u767B\u5F55\u51ED\u8BC1\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\u3002")), /* @__PURE__ */ React10.createElement("div", { id: "accounts" })), /* @__PURE__ */ React10.createElement(Panel, { title: "\u6DFB\u52A0\u8D26\u53F7" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "cap-start", variant: "default" }, "\u4ECE\u7535\u8111\u5FAE\u4FE1\u6DFB\u52A0"), /* @__PURE__ */ React10.createElement(Button, { id: "cap-douyin", variant: "outline" }, "\u4ECE\u7535\u8111\u6296\u97F3\u6DFB\u52A0"), /* @__PURE__ */ React10.createElement(Button, { id: "cap-stop", variant: "destructive" }, "\u505C\u6B62\u6293\u5305"), /* @__PURE__ */ React10.createElement("span", { id: "cap-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("div", { id: "cap-box" }))) },
    { id: "worlds", title: "\u533A\u670D", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u533A\u670D" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "load-worlds", variant: "outline" }, "\u52A0\u8F7D\u533A\u670D"), /* @__PURE__ */ React10.createElement(Input, { id: "world-input", "aria-label": "\u533A\u670D ID", placeholder: "\u533A\u670D ID", className: "w-32" }), /* @__PURE__ */ React10.createElement(Button, { id: "enter-world", variant: "outline" }, "\u8FDB\u5165\u8BE5\u533A\u670D"), /* @__PURE__ */ React10.createElement("span", { id: "worlds-hint", className: "warn" })), /* @__PURE__ */ React10.createElement("div", { id: "worlds" }))) },
    { id: "cred", title: "\u51ED\u8BC1", content: /* @__PURE__ */ React10.createElement(React10.Fragment, null, /* @__PURE__ */ React10.createElement(Panel, { title: "\u51ED\u8BC1" }, /* @__PURE__ */ React10.createElement("div", { className: "bar" }, /* @__PURE__ */ React10.createElement(Button, { id: "cred-show", variant: "outline" }, "\u663E\u793A\u51ED\u8BC1"), /* @__PURE__ */ React10.createElement(Button, { id: "cred-hide", variant: "outline" }, "\u6536\u8D77"), /* @__PURE__ */ React10.createElement("span", { className: "dim" }, "\u51ED\u8BC1\u662F\u672C\u673A\u7684\u660E\u6587\u6587\u4EF6\uFF0C\u53EA\u5728\u8FD9\u53F0\u7535\u8111\u4E0A\u7528")), /* @__PURE__ */ React10.createElement("div", { id: "cred" }))) }
  ] }));
}

// src/ui/console.tsx
function idlePanel(tasks) {
  return renderToStaticMarkup3(/* @__PURE__ */ React11.createElement("div", { className: "grid gap-4" }, /* @__PURE__ */ React11.createElement(Card, null, /* @__PURE__ */ React11.createElement(CardHeader, null, /* @__PURE__ */ React11.createElement(CardTitle, null, "\u5B9A\u65F6\u6302\u673A"), /* @__PURE__ */ React11.createElement(CardDescription, null, "\u8F6E\u6570\u586B 0 \u8868\u793A\u6301\u7EED\u8FD0\u884C\u3002\u6BCF\u8F6E\u53EA\u6267\u884C\u5F53\u524D\u8D26\u53F7\u5DF2\u5F00\u542F\u7684\u4EFB\u52A1\u3002")), /* @__PURE__ */ React11.createElement(CardContent, null, /* @__PURE__ */ React11.createElement("div", { className: "bar" }, /* @__PURE__ */ React11.createElement("label", { htmlFor: "loop-rounds" }, "\u8F6E\u6570"), /* @__PURE__ */ React11.createElement(Input, { id: "loop-rounds", type: "number", min: "0", defaultValue: "0", className: "w-20" }), /* @__PURE__ */ React11.createElement("label", { htmlFor: "loop-every" }, "\u95F4\u9694\uFF08\u79D2\uFF09"), /* @__PURE__ */ React11.createElement(Input, { id: "loop-every", type: "number", min: "1", max: "86400", defaultValue: "60", className: "w-24" }), /* @__PURE__ */ React11.createElement(Button, { id: "loop-start", disabled: true }, "\u5F00\u59CB\u6302\u673A"), /* @__PURE__ */ React11.createElement(Button, { id: "loop-stop", variant: "outline", disabled: true }, "\u6682\u505C\u6302\u673A")), /* @__PURE__ */ React11.createElement("div", { className: "dim", id: "loop-hint", role: "status" }))), /* @__PURE__ */ React11.createElement("div", { className: "idle-groups" }, Array.from(new Set(tasks.map((t) => t.group))).map((group) => /* @__PURE__ */ React11.createElement(Card, { key: group }, /* @__PURE__ */ React11.createElement(CardHeader, null, /* @__PURE__ */ React11.createElement(CardTitle, null, group)), /* @__PURE__ */ React11.createElement(CardContent, { className: "task-grid" }, tasks.filter((t) => t.group === group).map((t) => /* @__PURE__ */ React11.createElement("div", { className: "task-setting", key: t.key }, /* @__PURE__ */ React11.createElement("label", { htmlFor: "auto-" + t.key }, t.label, /* @__PURE__ */ React11.createElement("small", { id: "next-" + t.key, className: "block text-muted-foreground" })), /* @__PURE__ */ React11.createElement(Switch, { id: "auto-" + t.key, "data-auto-task": t.key, className: "p-0", disabled: true })))), group === "\u9493\u9C7C" && /* @__PURE__ */ React11.createElement(CardContent, null, /* @__PURE__ */ React11.createElement("form", { id: "fishing-reserve-form", className: "bar" }, /* @__PURE__ */ React11.createElement("label", { htmlFor: "fishing-reserve" }, "\u5F3A\u5316\u540E\u81F3\u5C11\u4FDD\u7559\u91D1\u5E01"), /* @__PURE__ */ React11.createElement(Input, { id: "fishing-reserve", type: "number", min: "0", step: "1", required: true, className: "w-32", disabled: true }), /* @__PURE__ */ React11.createElement(Button, { id: "fishing-reserve-save", type: "submit", variant: "outline", disabled: true }, "\u4FDD\u5B58"))))))));
}
function action(id, label, variant = "outline", disabled = false) {
  return renderToStaticMarkup3(/* @__PURE__ */ React11.createElement(Button, { id, variant, disabled }, label));
}
function stagePanel() {
  return renderToStaticMarkup3(
    /* @__PURE__ */ React11.createElement("div", { className: "grid gap-4" }, /* @__PURE__ */ React11.createElement(Card, null, /* @__PURE__ */ React11.createElement(CardHeader, null, /* @__PURE__ */ React11.createElement(CardTitle, null, "\u6311\u6218\u4E3B\u7EBF\u5173\u5361"), /* @__PURE__ */ React11.createElement(CardDescription, null, "\u624B\u52A8\u5F00\u542F\u540E\uFF0C\u6BCF\u573A\u95F4\u9694 5 \u79D2\u3002\u8FC7\u5173\u540E\u8FDE\u7EED\u5931\u8D25\u6B21\u6570\u6E05\u96F6\u3002")), /* @__PURE__ */ React11.createElement(CardContent, null, /* @__PURE__ */ React11.createElement("div", { className: "bar" }, /* @__PURE__ */ React11.createElement("label", { htmlFor: "stage-failures" }, "\u540C\u4E00\u5173\u8FDE\u7EED\u5931\u8D25\u51E0\u6B21\u540E\u505C\u6B62"), /* @__PURE__ */ React11.createElement(Input, { id: "stage-failures", className: "w-20", type: "number", min: "1", defaultValue: "3" }), /* @__PURE__ */ React11.createElement(Button, { id: "stage-start", disabled: true }, "\u5F00\u542F\u63A8\u5173"), /* @__PURE__ */ React11.createElement(Button, { id: "stage-stop", variant: "outline", disabled: true }, "\u505C\u6B62\u63A8\u5173")), /* @__PURE__ */ React11.createElement("p", { id: "stage-view", className: "dim", "aria-live": "polite" }, "\u5C1A\u672A\u5F00\u542F"))), /* @__PURE__ */ React11.createElement(Card, null, /* @__PURE__ */ React11.createElement(CardHeader, null, /* @__PURE__ */ React11.createElement(CardTitle, null, "\u8BD5\u70BC\u526F\u672C"), /* @__PURE__ */ React11.createElement(CardDescription, null, "\u6BCF\u6B21\u70B9\u51FB\u6311\u6218\u4E0B\u4E00\u5173\u3002\u901A\u5173\u540E\u53EF\u5728\u6302\u673A\u9875\u5F00\u542F\u514D\u8D39\u626B\u8361\u3002")), /* @__PURE__ */ React11.createElement(CardContent, null, /* @__PURE__ */ React11.createElement("div", { className: "bar" }, /* @__PURE__ */ React11.createElement(Button, { id: "trial-refresh", variant: "outline" }, "\u5237\u65B0\u8BD5\u70BC\u8FDB\u5EA6")), /* @__PURE__ */ React11.createElement("div", { id: "trial-view", className: "progression-view", "aria-live": "polite" }))))
  );
}
export {
  accountPage,
  action,
  activitiesPage,
  dailiesPage,
  dialogs,
  heroesPage,
  idlePanel,
  journal,
  manualPage,
  overviewPage,
  rail,
  stagePanel,
  templates,
  topbar
};
