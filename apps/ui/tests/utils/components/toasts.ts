import { Page, Locator } from '@playwright/test';

/**
 * Wait for a toast notification with specific text to appear
 */
export async function waitForToast(
  page: Page,
  text: string,
  options?: { timeout?: number }
): Promise<Locator> {
  const toast = page.locator(`[data-sonner-toast]:has-text("${text}")`).first();
  await toast.waitFor({
    timeout: options?.timeout ?? 5000,
    state: 'visible',
  });
  return toast;
}

/**
 * Wait for an error toast to appear with specific text
 */
export async function waitForErrorToast(
  page: Page,
  titleText?: string,
  options?: { timeout?: number }
): Promise<Locator> {
  // Try multiple selectors for error toasts since Sonner versions may differ
  // 1. Try with data-type="error" attribute
  // 2. Fallback to any toast with the text (error styling might vary)
  const timeout = options?.timeout ?? 5000;

  if (titleText) {
    // First try specific error type, then fallback to any toast with text
    const errorToast = page
      .locator(
        `[data-sonner-toast][data-type="error"]:has-text("${titleText}"), [data-sonner-toast]:has-text("${titleText}")`
      )
      .first();
    await errorToast.waitFor({
      timeout,
      state: 'visible',
    });
    return errorToast;
  } else {
    const errorToast = page.locator('[data-sonner-toast][data-type="error"]').first();
    await errorToast.waitFor({
      timeout,
      state: 'visible',
    });
    return errorToast;
  }
}

/**
 * Check if an error toast is visible
 */
export async function isErrorToastVisible(page: Page, titleText?: string): Promise<boolean> {
  const toastSelector = titleText
    ? `[data-sonner-toast][data-type="error"]:has-text("${titleText}")`
    : '[data-sonner-toast][data-type="error"]';

  const toast = page.locator(toastSelector).first();
  return await toast.isVisible();
}

/**
 * Wait for a success toast to appear with specific text
 */
export async function waitForSuccessToast(
  page: Page,
  titleText?: string,
  options?: { timeout?: number }
): Promise<Locator> {
  // Sonner toasts use data-sonner-toast and data-type="success" for success toasts
  const toastSelector = titleText
    ? `[data-sonner-toast][data-type="success"]:has-text("${titleText}")`
    : '[data-sonner-toast][data-type="success"]';

  const toast = page.locator(toastSelector).first();
  await toast.waitFor({
    timeout: options?.timeout ?? 5000,
    state: 'visible',
  });
  return toast;
}
