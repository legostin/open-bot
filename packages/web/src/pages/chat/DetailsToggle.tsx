// The detailed-mode switch in a dialog's top bar: tool calls and service messages are hidden unless it is on.

import { ListTree } from "lucide-react";
import { useStore } from "../../lib/store";
import { setShowDetails, showDetails } from "../../state/prefs";
import { IconButton } from "../../components/ui";
import { t } from "../../i18n";

export function DetailsToggle() {
  const on = useStore(showDetails);
  return (
    <IconButton label={on ? t("chat.detailsOff") : t("chat.detailsOn")} onClick={() => setShowDetails(!on)} active={on} className="ml-auto shrink-0">
      <ListTree className="size-[18px]" />
    </IconButton>
  );
}
