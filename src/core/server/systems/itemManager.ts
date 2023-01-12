import * as alt from 'alt-server';

import { Athena } from '@AthenaServer/api/athena';
import { BaseItem, StoredItem, Item, DefaultItemBehavior } from '@AthenaShared/interfaces/item';
import { deepCloneArray, deepCloneObject } from '@AthenaShared/utility/deepCopy';

type InventoryType = 'inventory' | 'equipment' | 'toolbar' | 'custom';

export interface ItemQuantityChange {
    /**
     * The modified item after making qunatity modifications to it.
     *
     * @type { Item | StoredItem }
     * @memberof ItemQuantityChange
     */
    item: Item | StoredItem;

    /**
     * The number of items that were not added to this stack.
     *
     * @type {number}
     * @memberof ItemQuantityChange
     */
    remaining: number;
}

/**
 * Do not modify this directly.
 * These are used as internal values.
 * Use the config setter / getter in ItemManager system to modify.
 * @type {*}
 * */
let DEFAULT = {
    inventory: {
        size: 28,
    },
    toolbar: {
        size: 4,
    },
    custom: {
        size: 256,
    },
};

const InternalFunctions = {
    item: {
        /**
         * Calculate the total weight of the item, and return the modified item with total weight.
         *
         * @param {BaseItem} baseItem
         * @param {StoredItem} storedItem
         * @returns {StoredItem}
         */
        calculateWeight(baseItem: BaseItem, storedItem: StoredItem): StoredItem {
            if (typeof baseItem.weight === 'number' && storedItem.quantity !== 0) {
                const newItem = deepCloneObject<StoredItem>(storedItem);
                newItem.totalWeight = baseItem.weight * newItem.quantity;
                return newItem;
            }

            return storedItem;
        },
        /**
         * Modifies an item by adding or removing an amount.
         * The amount that did not get removed, or added is returned.
         * If the base item of the item is not found it will return undefined.
         * It will automatically re-calculate weight if the baseItem weight is present.
         *
         * @param {ItemType} item
         * @param {number} amount
         * @param {boolean} [isRemoving=false]
         * @return {ItemQuantityChange}
         */
        modifyQuantity(item: Item | StoredItem, amount: number, isRemoving: boolean = false): ItemQuantityChange {
            amount = Math.floor(amount);

            // Lookup the base item based on the dbName of the item.
            const baseItem = Athena.systems.itemFactory.sync.getBaseItem(item.dbName, item.version);
            if (typeof baseItem === 'undefined') {
                alt.logWarning(`ItemManager: Tried to lookup ${item.dbName}, but base item does not exist.`);
                return undefined;
            }

            // Prevent stacking / modifying quantity if adding to the item.
            if (!isRemoving && baseItem.behavior && !baseItem.behavior.canStack) {
                return undefined;
            }

            // Get the remaining that could not be added or removed due to either stack size, or not enough of this item to remove.
            let remaining = 0;
            if (isRemoving && item.quantity < amount) {
                remaining = amount - item.quantity;
                amount = item.quantity; // Set the amount to the item quantity since we are removing it all.
            }

            if (!isRemoving && typeof baseItem.maxStack === 'number' && item.quantity + amount > baseItem.maxStack) {
                remaining = item.quantity + amount - baseItem.maxStack;
                amount = baseItem.maxStack - item.quantity; // Set the amount to the total necessary to fulfill the maximum stack size.
            }

            // Add or remove quantity from the item
            let newItem = deepCloneObject<Item | StoredItem>(item);
            if (isRemoving) {
                newItem.quantity -= amount;
            } else {
                newItem.quantity += amount;
            }

            newItem = InternalFunctions.item.calculateWeight(baseItem, newItem);

            return {
                item: newItem,
                remaining,
            };
        },
    },
    inventory: {
        /**
         * Remove all items with zero quantity.
         *
         * @param {(Array<StoredItem | Item>)} items
         * @return {(Array<StoredItem | Item>)}
         */
        removeZeroQuantityItems(items: Array<StoredItem | Item>): Array<StoredItem | Item> {
            const newItemsArray = deepCloneArray<StoredItem | Item>(items);

            for (let i = newItemsArray.length - 1; i >= 0; i--) {
                if (typeof newItemsArray[i] === 'undefined') {
                    continue;
                }

                if (newItemsArray[i].quantity > 0) {
                    continue;
                }

                newItemsArray.splice(i, 1);
            }

            return newItemsArray;
        },
    },
};

export const ItemManager = {
    config: {
        /**
         * Modify the existing inventory configurations.
         * Values set may not work with interfaces designed for default values above.
         *
         * @param {typeof DEFAULT} config
         */
        set(config: typeof DEFAULT) {
            DEFAULT = Object.assign(DEFAULT, config);
        },
        /**
         * Returns the current inventory configurations.
         *
         * @return {typeof DEFAULT}
         */
        get(): typeof DEFAULT {
            return DEFAULT;
        },
    },
    quantity: {
        /**
         * Adds a quantity to a specified item.
         * Utilizes the base item to determine maximum stack.
         * Will return the remaining amount that was not added if a max stack size is present.
         * Will return undefined if the base item does not exist, or if the item simply cannot have quantity changed.
         * Recalculated weight on item if baseItem has weight present.
         *
         * If you wish to modify a full item use `add<Item>(...)`
         *
         * @param {(Item | StoredItem)} item
         * @param {number} amount
         * @return {ItemType | undefined}
         */
        add(item: Item | StoredItem, amount: number): ItemQuantityChange | undefined {
            return InternalFunctions.item.modifyQuantity(item, amount);
        },
        /**
         * Removes a quantity from a specified item.
         * Will return the remaining amount that was not removed if amount exceeds available in stack size.
         * Will return undefined if the base item does not exist, or if the item simply cannot have quantity changed.
         *
         * If you wish to modify a full item use `remove<Item>(...)`
         *
         * @param {(Item | StoredItem)} item
         * @param {number} amount
         * @return {ItemQuantityChange | undefined}
         */
        sub(item: Item | StoredItem, amount: number): ItemQuantityChange | undefined {
            return InternalFunctions.item.modifyQuantity(item, amount, true);
        },
    },
    data: {
        /**
         * Update or insert the data field of an item with new data.
         * Any data that has a matching field with overwrite the existing field with the new data.
         * Always returns a new item with the modified contents.
         *
         * @template DataType
         * @param {(Item<DefaultItemBehavior, DataType> | StoredItem<DataType>)} item
         * @param {DataType} data
         */
        upsert<DataType = {}>(item: Item<DefaultItemBehavior, DataType> | StoredItem<DataType>, data: DataType) {
            const newItem = deepCloneObject<Item<DefaultItemBehavior, DataType> | StoredItem<DataType>>(item);
            if (typeof newItem.data !== 'object') {
                newItem.data = {} as DataType;
            }

            newItem.data = Object.assign(newItem.data, data);
            return newItem;
        },
        /**
         * Assign data to the data field.
         * Always returns a new item with the modified contents.
         *
         * @template DataType
         * @param {(Item<DefaultItemBehavior, DataType> | StoredItem<DataType>)} item
         * @param {DataType} data
         * @return {*}
         */
        set<DataType = {}>(item: Item<DefaultItemBehavior, DataType> | StoredItem<DataType>, data: DataType) {
            const newItem = deepCloneObject<Item<DefaultItemBehavior, DataType> | StoredItem<DataType>>(item);
            newItem.data = deepCloneObject(item);
            return newItem;
        },
        /**
         * Clears the data field of the item.
         * Sets it to an empty object.
         * Always returns a new item with the modified contents.
         *
         * @param {(Item | StoredItem)} item
         * @return {*}
         */
        clear(item: Item | StoredItem) {
            const newItem = deepCloneObject<Item | StoredItem>(item);
            newItem.data = {};
            return newItem;
        },
    },
    inventory: {
        /**
         * Adds or stacks an item based on the quantity passed.
         * Requires the basic version of a stored item to be added to a user.
         * Returns undefined if the data set could not be modified to include the quantity of items necessary.
         *
         * @param {string} type
         * @param {Array<StoredItem>} data
         * @param {number} amount
         * @return {Array<StoredItem>}
         */
        add<CustomData = {}>(
            type: InventoryType,
            item: StoredItem<CustomData>,
            data: Array<StoredItem>,
        ): Array<StoredItem> | undefined {
            // Lookup the base item based on the dbName of the item.
            const baseItem = Athena.systems.itemFactory.sync.getBaseItem(item.dbName, item.version);
            if (typeof baseItem === 'undefined') {
                alt.logWarning(`ItemManager: Tried to lookup ${item.dbName}, but base item does not exist.`);
                return undefined;
            }

            const copyOfData = deepCloneArray<StoredItem<CustomData>>(data);

            // What this should probably do:
            // - Take an existing item.
            // - Lookup if the base item exists.
            // - Loop through the array that was given and find all matching items with version.
            // - If the stack size is not max; try to append.
            // - Remove quantity added to stack size from quantity to add from main item.
            // - If quantity still remains; begin adding new items.
            // - New items should try to be appended to the array.

            return [];
        },
        sub<CustomData = {}>(
            type: InventoryType,
            item: StoredItem<CustomData>,
            data: Array<StoredItem>,
        ): Array<StoredItem> | undefined {
            // Lookup the base item based on the dbName of the item.
            const baseItem = Athena.systems.itemFactory.sync.getBaseItem(item.dbName, item.version);
            if (typeof baseItem === 'undefined') {
                alt.logWarning(`ItemManager: Tried to lookup ${item.dbName}, but base item does not exist.`);
                return undefined;
            }

            const copyOfData = deepCloneArray<StoredItem<CustomData>>(data);

            return [];
        },
        /**
         * Returns a numerical representation for a free slot.
         * If there are no more free slots for a given type it will return undefined.
         *
         * @param {InventoryType} type
         * @param {Array<StoredItem>} data
         * @return {(number | undefined)}
         */
        getFreeSlot(type: InventoryType, data: Array<StoredItem>): number | undefined {
            if (typeof DEFAULT[String(type)] === 'undefined') {
                return undefined;
            }

            const maxSlot = DEFAULT[String(type)].size;
            for (let i = 0; i < maxSlot; i++) {
                const index = data.findIndex((x) => x.slot === i);
                if (index >= 0) {
                    continue;
                }

                return i;
            }

            return undefined;
        },
        /**
         * Takes existing items and combines like items with same version.
         * Automatically meets max stack standards.
         *
         * @param {Array<StoredItem>} data
         */
        conslidate(data: Array<StoredItem>) {
            //
        },
    },
};
