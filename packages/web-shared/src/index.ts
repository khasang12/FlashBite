// Re-export the order contracts the frontends consume.
export type { OrderItem, OrderView, OrderPaymentView } from "@flashbite/contracts";
export { ORDER_STATUS } from "@flashbite/contracts";
export { DISPATCH_STATUS } from "@flashbite/contracts";
export type { DispatchView, DispatchStatus } from "@flashbite/contracts";
export type { TenantView } from "@flashbite/contracts";

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

export {
  placeOrder, getOrder, fetchOrderPayment, listOrders, acceptOrder, declineOrder, confirmPayment,
  reportLocation, getNearbyDrivers,
  getAdminOrders, getAdminDrivers,
  getTenants,
  goOnline, goOffline, getDriverOnline, acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDispatchForDriver, getOrderDispatch, getMerchantDispatches, getOrderDriverLocation,
  UnauthorizedError,
  type PlaceOrderRequest, type NearbyDriver, type ReportLocationBody, type TenantNearbyDriver,
} from "./api/client";
export { statusFromEventType, upsertOrder, applyOrderEvent, cancelReasonLabel, paymentStatusLabel, type OrderStreamEvent } from "./orders/order-events";
export {
  aggregateGmv, gmvByTenant, statusBreakdown, topSkus, gmvOverTime, orderCounts, replaceTenantOrders,
  type TenantGmv, type TenantStatusCounts, type SkuCount, type GmvBucket, type OrderCounts,
} from "./orders/analytics";
export type { Tenant } from "./store/tenant-store";
export { useCartStore, type CartLine } from "./store/cart-store";
export { type GeoPoint } from "./geo/types";
export { toNearbyRows, formatKm } from "./geo/nearby";
export { getMenu, getPopular, type MenuItem } from "./menu/seed";
export { QtyStepper } from "./components/qty-stepper";
export { StatusPill } from "./components/status-pill";
export { dispatchStatusLabel, deliveryStatusLabel, DISPATCH_OFFER_TIMEOUT_SECONDS } from "./dispatch/labels";
export { useDispatchStream, parseDispatchData, reduceDispatch } from "./dispatch/use-dispatch-stream";
export { useTenantDispatchStream, reduceDispatchMap, type DispatchMap } from "./dispatch/use-tenant-dispatch-stream";
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
export { useAuthStore, type AuthClaims } from "./store/auth-store";
export { LoginForm, type DemoUser } from "./components/login-form";
export { AuthGate } from "./components/auth-gate";
export { useTenants } from "./tenants/use-tenants";
