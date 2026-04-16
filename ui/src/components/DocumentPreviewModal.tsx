import type { IssueDocument } from "@paperclipai/shared";
import { relativeTime } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DocumentPreviewModal({
  document: doc,
  open,
  onOpenChange,
  onImageClick,
}: {
  document: IssueDocument | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImageClick?: (src: string) => void;
}) {
  if (!doc) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <span>{doc.title || doc.key}</span>
            <span className="text-xs font-normal text-muted-foreground">
              rev {doc.latestRevisionNumber} · updated {relativeTime(doc.updatedAt)}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-auto flex-1 rounded-md border border-border px-6 py-4">
          <MarkdownBody
            className="prose prose-sm dark:prose-invert max-w-none"
            onImageClick={onImageClick}
          >
            {doc.body}
          </MarkdownBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}
