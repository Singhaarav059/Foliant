import { Account } from "@/components/Account";
import { titleFrom } from "@/lib/i18n/meta";

export const generateMetadata = titleFrom("acc.title");

export default function AccountPage() {
  return <Account />;
}
