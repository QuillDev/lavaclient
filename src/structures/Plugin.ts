import type { Manager } from "./Manager";

export abstract class Plugin {
  /**
   * The manager that loaded this plugin.
   */
  public manager!: Manager;

  /**
   * Called when this plugin is loaded.
   * @param manager The manager that loaded this plugin.
   * @since 3.0.0
   */
  public load(manager: Manager): void {
    this.manager = manager;
    return;
  }

  /**
   * Called when the manager is initialized.
   * @since 3.0.0
   */
  public init(): void {
    return;
  }
}