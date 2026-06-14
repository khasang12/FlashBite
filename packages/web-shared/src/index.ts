// Re-export the order contracts the frontends consume.
export type { OrderItem, OrderView } from "@flashbite/contracts";
export { ORDER_STATUS } from "@flashbite/contracts";

// Design-system primitives (shadcn/ui, new-york).
export { cn } from "./lib/utils";

export { Button, buttonVariants } from "./components/ui/button";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./components/ui/card";
export { Badge, badgeVariants } from "./components/ui/badge";
export { Input } from "./components/ui/input";
export { Separator } from "./components/ui/separator";
export { Skeleton } from "./components/ui/skeleton";
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./components/ui/dropdown-menu";
export {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from "./components/ui/carousel";

export { placeOrder, getOrder, listOrders, acceptOrder, declineOrder, type PlaceOrderRequest } from "./api/client";
export { statusFromEventType, upsertOrder, applyOrderEvent, type OrderStreamEvent } from "./orders/order-events";
export { useTenantStore, TENANTS, type Tenant } from "./store/tenant-store";
export { useCartStore, type CartLine } from "./store/cart-store";
export { getMenu, getPopular, type MenuItem } from "./menu/seed";
export { QtyStepper } from "./components/qty-stepper";
export { StatusPill } from "./components/status-pill";
export { useOrderStream, parseStreamData } from "./orders/use-order-stream";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./components/ui/table";
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";
export { DataTable, type DataTableProps } from "./components/data-table";
export type { ColumnDef } from "@tanstack/react-table";
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
} from "./components/ui/select";
