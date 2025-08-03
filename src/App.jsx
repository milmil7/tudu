import React, { useState, useEffect, useReducer, useRef } from 'react';
import {webviewWindow} from "@tauri-apps/api";

// --- Helper Functions ---
// Recurrence calculation
const getNextRecurrenceDate = (startDate, recurrence) => {
    if (!startDate || !recurrence) return null;
    const date = new Date(startDate);
    const now = new Date();

    while (date < now) {
        if (recurrence === 'daily') {
            date.setDate(date.getDate() + 1);
        } else if (recurrence === 'weekly') {
            date.setDate(date.getDate() + 7);
        } else if (recurrence === 'monthly') {
            date.setMonth(date.getMonth() + 1);
        }
    }
    return date.toISOString().split('T')[0];
};

// Undo/Redo logic
const undoable = (reducer) => {
    const initialState = {
        history: [reducer(undefined, {})],
        historyIndex: 0
    };
    return (state = initialState, action) => {
        if (action.type === 'UNDO') {
            const prevIndex = Math.max(0, state.historyIndex - 1);
            return { ...state, historyIndex: prevIndex };
        }
        if (action.type === 'REDO') {
            const nextIndex = Math.min(state.history.length - 1, state.historyIndex + 1);
            return { ...state, historyIndex: nextIndex };
        }
        const newPresent = reducer(state.history[state.historyIndex], action);
        if (newPresent === state.history[state.historyIndex]) {
            return state;
        }
        const newHistory = state.history.slice(0, state.historyIndex + 1);
        return {
            history: [...newHistory, newPresent],
            historyIndex: newHistory.length
        };
    };
};

// Helper function to recursively toggle all nested subtasks and their subtasks
const toggleAllNestedTasks = (tasks, completedStatus) => {
    if (!Array.isArray(tasks)) return [];
    return tasks.map(task => {
        const updatedSubtasks = toggleAllNestedTasks(task.subtasks, completedStatus);
        return { ...task, completed: completedStatus, subtasks: updatedSubtasks };
    });
};

// Recursive helper to find and update a nested task
const findTaskAndUpdate = (tasks, idPath, updateFunction) => {
    // Base case: if there are no more IDs in the path, this is the task to update
    if (idPath.length === 1) {
        return tasks.map(task => {
            if (task.id === idPath[0]) {
                return updateFunction(task);
            }
            return task;
        });
    }

    // Recursive step: find the correct parent task and recurse
    const [currentId, ...restOfPath] = idPath;
    return tasks.map(task => {
        if (task.id === currentId) {
            const updatedSubtasks = findTaskAndUpdate(task.subtasks, restOfPath, updateFunction);
            return { ...task, subtasks: updatedSubtasks };
        }
        return task;
    });
};

// Main reducer for managing to-do list state
const todoReducer = (state = [], action) => {
    switch (action.type) {
        case 'ADD_TODO': {
            const { text, dueDate, priority, tags, startDate, recurrence, description } = action.payload;
            const newTodo = {
                id: crypto.randomUUID(),
                text: text,
                completed: false,
                createdAt: new Date().toISOString(),
                dueDate: dueDate || null,
                priority: priority,
                tags: tags,
                description: description,
                subtasks: [],
            };
            return [newTodo, ...state];
        }
        case 'ADD_NESTED_TASK': {
            const { idPath, text, dueDate, startDate, recurrence, priority, tags, description } = action.payload;
            const newSubtask = {
                id: crypto.randomUUID(),
                text,
                completed: false,
                createdAt: new Date().toISOString(),
                dueDate,
                startDate,
                recurrence,
                priority,
                tags,
                description,
                subtasks: [],
            };
            // Find the parent and add the new subtask
            return findTaskAndUpdate(state, idPath, (parentTask) => {
                return { ...parentTask, subtasks: [newSubtask, ...parentTask.subtasks] };
            });
        }
        case 'TOGGLE_TODO':
            return state.map(todo => {
                if (todo.id === action.payload.id) {
                    const newCompletedState = !todo.completed;
                    let newDueDate = todo.dueDate;
                    let newStartDate = todo.startDate;
                    if (newCompletedState && todo.recurrence) {
                        newDueDate = getNextRecurrenceDate(todo.dueDate, todo.recurrence);
                        newStartDate = getNextRecurrenceDate(todo.startDate, todo.recurrence);
                    }
                    const updatedSubtasks = toggleAllNestedTasks(todo.subtasks, newCompletedState);
                    return { ...todo, completed: newCompletedState, subtasks: updatedSubtasks, dueDate: newDueDate, startDate: newStartDate };
                }
                return todo;
            });
        case 'TOGGLE_NESTED_TASK': {
            const { idPath } = action.payload;
            return findTaskAndUpdate(state, idPath, (task) => {
                const newCompletedState = !task.completed;
                let newDueDate = task.dueDate;
                let newStartDate = task.startDate;
                if (newCompletedState && task.recurrence) {
                    newDueDate = getNextRecurrenceDate(task.dueDate, task.recurrence);
                    newStartDate = getNextRecurrenceDate(task.startDate, task.recurrence);
                }
                const updatedSubtasks = toggleAllNestedTasks(task.subtasks, newCompletedState);
                return { ...task, completed: newCompletedState, subtasks: updatedSubtasks, dueDate: newDueDate, startDate: newStartDate };
            });
        }
        case 'DELETE_TODO':
            return state.filter(todo => todo.id !== action.payload.id);
        case 'DELETE_NESTED_TASK': {
            const { idPath } = action.payload;
            const [parentPath, targetId] = [idPath.slice(0, -1), idPath.slice(-1)[0]];
            // If parentPath is empty, it's a top-level task being deleted, handled by DELETE_TODO
            if (parentPath.length === 0) {
                return state.filter(task => task.id !== targetId);
            }
            return findTaskAndUpdate(state, parentPath, (parentTask) => {
                const updatedSubtasks = parentTask.subtasks.filter(task => task.id !== targetId);
                return { ...parentTask, subtasks: updatedSubtasks };
            });
        }
        case 'UPDATE_TODO':
            return state.map(todo => (todo.id === action.payload.id ? { ...todo, ...action.payload.updates } : todo));
        case 'UPDATE_NESTED_TASK': {
            const { idPath, updates } = action.payload;
            return findTaskAndUpdate(state, idPath, (task) => {
                return { ...task, ...updates };
            });
        }
        case 'REORDER_TODOS': {
            const { dragId, dropId } = action.payload;
            const dragIndex = state.findIndex(t => t.id === dragId);
            const dropIndex = state.findIndex(t => t.id === dropId);
            const newTodos = [...state];
            const [draggedTodo] = newTodos.splice(dragIndex, 1);
            newTodos.splice(dropIndex, 0, draggedTodo);
            return newTodos;
        }
        case 'CLEAR_COMPLETED':
            const newTodos = state.filter(todo => !todo.completed);
            const clearNestedCompleted = (tasks) => tasks.filter(task => !task.completed).map(task => ({ ...task, subtasks: clearNestedCompleted(task.subtasks) }));
            return newTodos.map(todo => ({ ...todo, subtasks: clearNestedCompleted(todo.subtasks) }));
        case 'IMPORT_TODOS':
            return action.payload;
        default:
            return state;
    }
};

const useUndoableReducer = (reducer, initialPresent) => {
    const [state, dispatch] = useReducer(undoable(reducer), {
        history: [initialPresent],
        historyIndex: 0
    });
    const present = state.history[state.historyIndex];
    return [present, dispatch, state.historyIndex > 0, state.historyIndex < state.history.length - 1];
};

const getInitialState = () => {
    try {
        const localData = localStorage.getItem('localTodos');
        const parsedData = localData ? JSON.parse(localData) : [];
        // Ensure the parsed data is an array
        return Array.isArray(parsedData) ? parsedData : [];
    } catch (e) {
        console.error("Failed to load or parse todos from local storage:", e);
        return [];
    }
};

const KanbanColumn = ({ title, tasks, dispatch }) => (
    <div className="flex-1 min-w-[280px] bg-white border-3 border-black p-4 rounded-none neubrutalist-shadow transition-all duration-100 ease-in-out hover:scale-[1.01]">
        <h3 className="text-xl font-black mb-4 text-gray-900 border-b-4 border-black pb-2">{title}</h3>
        <ul className="space-y-4">
            {tasks.map(todo => (
                <TodoItem key={todo.id} todo={todo} dispatch={dispatch} />
            ))}
        </ul>
    </div>
);

// New SubtaskForm component to handle adding subtasks and nested subtasks
const SubtaskForm = ({ parentIdPath = [], dispatch }) => {
    const [inputValue, setInputValue] = useState('');
    const [inputDueDate, setInputDueDate] = useState('');
    const [inputStartDate, setInputStartDate] = useState('');
    const [inputRecurrence, setInputRecurrence] = useState('');
    const [inputPriority, setInputPriority] = useState('Low');
    const [inputDescription, setInputDescription] = useState('');
    const [tags, setTags] = useState([]);
    const [tagInput, setTagInput] = useState('');

    const handleAdd = (e) => {
        e.preventDefault();
        if (inputValue.trim() === '') return;
        const payload = {
            idPath: parentIdPath,
            text: inputValue,
            dueDate: inputDueDate,
            startDate: inputStartDate,
            recurrence: inputRecurrence,
            priority: inputPriority,
            tags,
            description: inputDescription
        };

        if (parentIdPath.length === 0) {
            dispatch({ type: 'ADD_TODO', payload: payload });
        } else {
            dispatch({ type: 'ADD_NESTED_TASK', payload: payload });
        }

        setInputValue('');
        setInputDueDate('');
        setInputStartDate('');
        setInputRecurrence('');
        setInputPriority('Low');
        setTags([]);
        setTagInput('');
        setInputDescription('');
    };

    const handleAddTag = (e) => {
        e.preventDefault();
        if (tagInput.trim() !== '') {
            setTags([...tags, tagInput.trim()]);
            setTagInput('');
        }
    };

    const handleRemoveTag = (tagToRemove) => {
        setTags(tags.filter(tag => tag !== tagToRemove));
    };

    const placeholderText = parentIdPath.length > 0 ? 'Add a new subtask...' : 'Add a new to-do...';
    const buttonText = parentIdPath.length > 0 ? 'ADD SUBTASK' : 'ADD TO-DO';

    return (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 py-2 px-2 bg-white border-3 border-black neubrutalist-shadow">
            <input type="text" value={inputValue} onChange={(e) => setInputValue(e.target.value)} placeholder={placeholderText} className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2"/>
            <textarea value={inputDescription} onChange={(e) => setInputDescription(e.target.value)} placeholder="Add a description..." className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2"></textarea>
            <div className="flex flex-col sm:flex-row gap-2">
                <input type="date" value={inputStartDate} onChange={(e) => setInputStartDate(e.target.value)} className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2 w-full"/>
                <input type="date" value={inputDueDate} onChange={(e) => setInputDueDate(e.target.value)} className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2 w-full"/>
                <select value={inputPriority} onChange={(e) => setInputPriority(e.target.value)} className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2 w-full">
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                </select>
                <select value={inputRecurrence} onChange={(e) => setInputRecurrence(e.target.value)} className="p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2 w-full">
                    <option value="">No Recurrence</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                </select>
            </div>
            <div className="flex gap-2">
                <input type="text" value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="Add tags" className="flex-grow p-1 px-2 border-3 border-black neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2"/>
                <button type="button" onClick={handleAddTag} className="px-3 py-1 text-sm font-bold bg-purple-400 text-black border-3 border-black neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover">ADD TAG</button>
            </div>
            <div className="flex flex-wrap gap-2">
                {tags.map((tag, index) => (
                    <span key={index} className="bg-purple-300 text-black text-sm px-3 py-1 font-bold border-2 border-black flex items-center gap-1 neubrutalist-shadow">
            {tag}
                        <button onClick={() => handleRemoveTag(tag)} className="text-black font-extrabold ml-1 leading-none">&times;</button>
          </span>
                ))}
            </div>
            <button type="submit" className="p-4 bg-blue-500 text-black font-black text-xl border-3 border-black neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover">{buttonText}</button>
        </form>
    );
};


// Main App component
export default function App() {
    const [todos, dispatch, canUndo, canRedo] = useUndoableReducer(todoReducer, getInitialState());
    const [showClearModal, setShowClearModal] = useState(false);
    const [filter, setFilter] = useState('all');
    const [sortBy, setSortBy] = useState('priority');
    const [sortOrder, setSortOrder] = useState('asc');
    const [filteredTag, setFilteredTag] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [view, setView] = useState('list');
    const fileInputRef = useRef(null);
    const [showImportExportModal, setShowImportExportModal] = useState(false);
    const [showUndoRedoMessage, setShowUndoRedoMessage] = useState(false);
    const [showCreator, setShowCreator] = useState(true);

    // Effect to save todos to local storage whenever they change
    useEffect(() => {
        try {
            localStorage.setItem('localTodos', JSON.stringify(todos));
        } catch (e) {
            console.error("Failed to save todos from local storage:", e);
        }
    }, [todos]);

    // Effect for desktop notifications
    useEffect(() => {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
        const interval = setInterval(() => {
            if ('Notification' in window && Notification.permission === 'granted') {
                const now = new Date();
                const upcomingTasks = todos.filter(todo => {
                    if (!todo.dueDate || todo.completed) return false;
                    const dueDate = new Date(todo.dueDate);
                    const timeUntilDue = dueDate.getTime() - now.getTime();
                    // Notify if task is due in the next 24 hours
                    return timeUntilDue > 0 && timeUntilDue <= 24 * 60 * 60 * 1000;
                });

                upcomingTasks.forEach(task => {
                    new Notification('Upcoming To-Do', {
                        body: `${task.text} is due on ${new Date(task.dueDate).toLocaleDateString()}`,
                        icon: 'https://placehold.co/48x48/000000/FFFFFF?text=🔔'
                    });
                });
            }
        }, 60 * 60 * 1000); // Check every hour
        return () => clearInterval(interval);
    }, [todos]);


    const handleClearCompleted = () => {
        setShowClearModal(false);
        dispatch({ type: 'CLEAR_COMPLETED' });
    };

    const getFilteredAndSortedTodos = () => {
        let filtered = todos.filter(todo =>
            (todo.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
                todo.description?.toLowerCase().includes(searchQuery.toLowerCase()))
        );

        if (filteredTag) {
            filtered = filtered.filter(todo => todo.tags && todo.tags.includes(filteredTag));
        }

        switch (filter) {
            case 'active':
                filtered = filtered.filter((todo) => !todo.completed);
                break;
            case 'completed':
                filtered = filtered.filter((todo) => todo.completed);
                break;
            default:
                break;
        }

        return filtered.sort((a, b) => {
            const priorityOrder = { 'High': 3, 'Medium': 2, 'Low': 1 };

            if (sortBy === 'priority') {
                const aVal = priorityOrder[a.priority] || 0;
                const bVal = priorityOrder[b.priority] || 0;
                return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
            }

            if (sortBy === 'dueDate') {
                const aVal = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
                const bVal = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
                return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
            }

            const aCreatedAt = new Date(a.createdAt).getTime() || 0;
            const bCreatedAt = new Date(b.createdAt).getTime() || 0;
            return bCreatedAt - aCreatedAt;
        });
    };

    const handleExport = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(todos));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "local_todos.json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };

    const handleImport = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedTodos = JSON.parse(event.target.result);
                if (Array.isArray(importedTodos)) {
                    dispatch({ type: 'IMPORT_TODOS', payload: importedTodos });
                } else {
                    // You could use a custom modal here instead of an alert
                }
            } catch (error) {
                // You could use a custom modal here instead of an alert
                console.error('Import error:', error);
            }
        };
        reader.readAsText(file);
        setShowImportExportModal(false);
    };

    const handleUndo = () => {
        dispatch({ type: 'UNDO' });
        setShowUndoRedoMessage(true);
        setTimeout(() => setShowUndoRedoMessage(false), 2000);
    };

    const handleRedo = () => {
        dispatch({ type: 'REDO' });
        setShowUndoRedoMessage(true);
        setTimeout(() => setShowUndoRedoMessage(false), 2000);
    };

    const filteredAndSortedTodos = getFilteredAndSortedTodos();

    const handleReorder = (dragId, dropId) => {
        dispatch({ type: 'REORDER_TODOS', payload: { dragId, dropId } });
    };

    const getKanbanColumns = () => {
        const overdue = todos.filter(t => t.dueDate && !t.completed && new Date(t.dueDate) < new Date());
        const upcoming = todos.filter(t => t.dueDate && !t.completed && new Date(t.dueDate) >= new Date());
        const completed = todos.filter(t => t.completed);
        return { overdue, upcoming, completed };
    };

    const kanbanColumns = getKanbanColumns();

    const NeumorphismStyle = `
    .neubrutalist-shadow {
        box-shadow: 3px 3px 0px 0px rgba(0, 0, 0, 1);
    }
    .neubrutalist-shadow-hover:hover {
        box-shadow: 0px 0px 0px 0px rgba(0, 0, 0, 1);
        transform: translate(3px, 3px);
    }
  `;

    return (
        <div className="min-h-screen bg-emerald-300 pt-16 flex items-center justify-center p-4 font-inter">
            <style>{NeumorphismStyle}</style>

            {/* Modals and Notifications */}
            {showClearModal && (<Modal title="Clear Completed Tasks?" onConfirm={handleClearCompleted} onCancel={() => setShowClearModal(false)} />)}
            {showImportExportModal && (<ImportExportModal onImport={() => fileInputRef.current.click()} onExport={handleExport} onClose={() => setShowImportExportModal(false)} fileInputRef={fileInputRef} handleImport={handleImport} />)}
            {showUndoRedoMessage && (<div className="fixed top-4 right-4 z-[100] bg-black text-white px-4 py-2 font-black rounded-sm border-2 border-white neubrutalist-shadow animate-fade-in-out">Action undone/redone!</div>)}

            <div className="bg-whit rounded-none w-full mx-auto relative ">
                {/* Header Controls */}
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-6">
                    <div className="flex items-center gap-2">
                        <button onClick={() => setView('list')} className={`px-4 py-2 text-base font-bold border-3 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out ${view === 'list' ? 'bg-blue-500 text-black' : 'bg-gray-200 text-gray-700'}`}>List View</button>
                        <button onClick={() => setView('kanban')} className={`px-4 py-2 text-base font-bold border-3 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out ${view === 'kanban' ? 'bg-blue-500 text-black' : 'bg-gray-200 text-gray-700'}`}>Kanban Board</button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={handleUndo} disabled={!canUndo} className={`p-2 border-3 border-black transition-all duration-100 ease-in-out ${canUndo ? 'bg-gray-800 text-white neubrutalist-shadow-hover' : 'bg-gray-200 text-gray-400'}`} aria-label="Undo last action">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 10l-6 6 6 6v-4h9a4 4 0 0 0 0-8h-9v-4z"/></svg>
                        </button>
                        <button onClick={handleRedo} disabled={!canRedo} className={`p-2 border-3 border-black transition-all duration-100 ease-in-out ${canRedo ? 'bg-gray-800 text-white neubrutalist-shadow-hover' : 'bg-gray-200 text-gray-400'}`} aria-label="Redo last action">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 10l6 6-6 6v-4h-9a4 4 0 0 1 0-8h9v-4z"/></svg>
                        </button>
                    </div>
                </div>

                {/* Collapsible Input Form */}
                <div className="p-4 bg-gray-100 border-3 border-black mb-6 neubrutalist-shadow">
                    <div className="flex justify-between items-center cursor-pointer" onClick={() => setShowCreator(!showCreator)}>
                        <h2 className="text-xl font-black text-gray-900">ADD NEW TO-DO</h2>
                        <button className="p-1 border-3 border-black bg-white text-gray-700 neubrutalist-shadow-hover">
                            <svg className={`w-5 h-5 transition-transform duration-300 ${showCreator ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                    </div>
                    {showCreator && (
                        <div className="mt-4 flex flex-col gap-3 transition-all duration-300">
                            <SubtaskForm dispatch={dispatch} />
                        </div>
                    )}
                </div>

                {/* Filters, Sorts, and Search */}
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-6">
                    <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="SEARCH TASKS..." className="px-3 py-1 border-3 border-black bg-gray-300 neubrutalist-shadow focus:outline-none focus:ring-4 focus:ring-blue-500 focus:ring-offset-2 w-full sm:w-auto flex-grow font-bold" />
                    <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                        <button onClick={() => setFilter('all')} className={`px-4 py-1 text-base font-bold border-3 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out flex-grow ${filter === 'all' ? 'bg-blue-500 text-black' : 'bg-gray-200 text-gray-700'}`}>ALL</button>
                        <button onClick={() => setFilter('active')} className={`px-4 py-1 text-base font-bold border-3 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out flex-grow ${filter === 'active' ? 'bg-blue-500 text-black' : 'bg-gray-200 text-gray-700'}`}>ACTIVE</button>
                        <button onClick={() => setFilter('completed')} className={`px-4 py-1 text-base font-bold border-3 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out flex-grow ${filter === 'completed' ? 'bg-blue-500 text-black' : 'bg-gray-200 text-gray-700'}`}>COMPLETED</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-6">
                    <span className="text-gray-900 font-bold">FILTER BY TAG:</span>
                    {[...new Set(todos.flatMap(todo => todo.tags || []).filter(t => t))].map(tag => (
                        <button key={tag} onClick={() => setFilteredTag(filteredTag === tag ? null : tag)} className={`px-3 py-1 font-bold text-sm border-2 border-black neubrutalist-shadow-hover transition-all duration-100 ease-in-out ${filteredTag === tag ? 'bg-purple-500 text-white' : 'bg-purple-300 text-black'}`}>
                            #{tag.toUpperCase()}
                        </button>
                    ))}
                </div>

                {/* Main Task Display Area */}
                {view === 'list' ? (
                    <ul className="space-y-4">
                        {filteredAndSortedTodos.map((todo) => (
                            <TodoItem
                                key={todo.id}
                                todo={todo}
                                dispatch={dispatch}
                                onReorder={handleReorder}
                            />
                        ))}
                    </ul>
                ) : (
                    // Updated parent container for Kanban columns to use `flex-wrap`
                    <div className="flex flex-col flex-wrap justify-center md:flex-nowrap gap-4">
                        <KanbanColumn title="OVERDUE" tasks={kanbanColumns.overdue} dispatch={dispatch} />
                        <KanbanColumn title="UPCOMING" tasks={kanbanColumns.upcoming} dispatch={dispatch} />
                        <KanbanColumn title="COMPLETED" tasks={kanbanColumns.completed} dispatch={dispatch} />
                    </div>
                )}

                {filteredAndSortedTodos.length === 0 && (
                    <p className="text-center text-gray-900 font-bold italic mt-6 text-lg">
                        {searchQuery.trim() !== '' ? 'No tasks found matching your search.' : 'YOUR TO-DO LIST IS EMPTY. ADD A TASK ABOVE!'}
                    </p>
                )}

                <div className="flex flex-wrap justify-center mt-6 gap-4">
                    <button onClick={() => setShowClearModal(true)} className="px-6 py-3 border-3 border-black bg-red-500 text-black font-black text-sm neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover">
                        CLEAR COMPLETED
                    </button>
                    <button onClick={() => setShowImportExportModal(true)} className="px-6 py-3 border-3 border-black bg-gray-800 text-white font-black text-sm neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover">
                        IMPORT/EXPORT DATA
                    </button>
                </div>
            </div>
        </div>
    );
}

// Sub-components
const Modal = ({ title, onConfirm, onCancel }) => (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 font-inter">
        <div className="bg-white p-8 border-3 border-black neubrutalist-shadow max-w-sm w-full text-center animate-fade-in">
            <h2 className="text-2xl font-black mb-4 text-gray-900 border-b-4 border-black pb-2">{title}</h2>
            <p className="text-gray-700 mb-6 font-bold">This action cannot be undone.</p>
            <div className="flex justify-center gap-4">
                <button onClick={onCancel} className="px-6 py-3 border-3 border-black bg-gray-200 text-gray-800 font-bold neubrutalist-shadow-hover">CANCEL</button>
                <button onClick={onConfirm} className="px-6 py-3 border-3 border-black bg-red-500 text-black font-bold neubrutalist-shadow-hover">CLEAR</button>
            </div>
        </div>
    </div>
);

const ImportExportModal = ({ onImport, onExport, onClose, fileInputRef, handleImport }) => (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 font-inter">
        <div className="bg-white p-8 border-3 border-black neubrutalist-shadow max-w-sm w-full text-center animate-fade-in">
            <h2 className="text-2xl font-black mb-4 text-gray-900 border-b-4 border-black pb-2">MANAGE YOUR DATA</h2>
            <p className="text-gray-700 mb-6 font-bold">Import to load data or export for a backup.</p>
            <div className="flex flex-col gap-4">
                <button onClick={onExport} className="px-6 py-3 border-3 border-black bg-blue-500 text-black font-black neubrutalist-shadow-hover">
                    EXPORT TO JSON
                </button>
                <button onClick={onImport} className="px-6 py-3 border-3 border-black bg-white text-gray-800 font-black neubrutalist-shadow-hover">
                    IMPORT FROM JSON
                </button>
                <input type="file" ref={fileInputRef} onChange={handleImport} className="hidden" accept=".json" />
                <button onClick={onClose} className="px-6 py-3 border-3 border-black bg-gray-200 text-gray-800 font-black neubrutalist-shadow-hover">
                    CLOSE
                </button>
            </div>
        </div>
    </div>
);


const NestedTaskItem = ({ task, parentIdPath, dispatch }) => {
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState(task.text);
    const [showSubtaskForm, setShowSubtaskForm] = useState(false);

    const currentIdPath = [...parentIdPath, task.id];

    const handleToggle = () => {
        dispatch({ type: 'TOGGLE_NESTED_TASK', payload: { idPath: currentIdPath } });
    };

    const handleDelete = () => {
        dispatch({ type: 'DELETE_NESTED_TASK', payload: { idPath: currentIdPath } });
    };

    const handleEdit = () => {
        if (editText.trim() !== '') {
            dispatch({ type: 'UPDATE_NESTED_TASK', payload: { idPath: currentIdPath, updates: { text: editText } } });
        }
        setEditing(false);
    };

    const handleEditKeyPress = (e) => {
        if (e.key === 'Enter') handleEdit();
    };

    const isOverdue = task.dueDate && !task.completed && new Date() > new Date(task.dueDate);
    const priorityColors = { 'High': 'bg-red-500 text-black', 'Medium': 'bg-yellow-400 text-black', 'Low': 'bg-green-400 text-black' };
    const hasNestedTasks = task.subtasks && task.subtasks.length > 0;

    // Calculate progress for nested tasks
    const getProgress = (tasks) => {
        let totalTasks = 0;
        let completedTasks = 0;

        const countTasks = (t) => {
            totalTasks++;
            if (t.completed) completedTasks++;
            if (t.subtasks && t.subtasks.length > 0) {
                t.subtasks.forEach(s => countTasks(s));
            }
        };

        if (tasks && tasks.length > 0) {
            tasks.forEach(t => countTasks(t));
        }

        if (totalTasks === 0) return 0;
        return Math.round((completedTasks / totalTasks) * 100);
    };

    const progress = getProgress(task.subtasks);

    return (
        <li className={`flex flex-col p-4 border-3 border-black neubrutalist-shadow transition-all duration-300 ${
            task.completed ? 'bg-gray-300 text-gray-700' : 'bg-white hover:bg-gray-100 neubrutalist-shadow-hover'
        } ${isOverdue ? '!bg-red-200' : ''}`}>
            <div className="flex flex-col md:flex-row items-start md:items-center w-full">
                <div className="flex-grow flex items-center gap-4 mb-2 md:mb-0 w-full">
                    <button onClick={handleToggle} className={`flex-shrink-0 w-6 h-6 border-3 border-black neubrutalist-shadow-hover focus:outline-none transition-all duration-200 ${
                        task.completed ? 'bg-green-500' : 'bg-white'
                    }`} aria-label={`Toggle task: ${task.text}`}>
                        {task.completed && (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mx-auto my-auto"><polyline points="20 6 9 17 4 12" /></svg>)}
                    </button>
                    {editing ? (
                        <input type="text" value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={handleEdit} onKeyPress={handleEditKeyPress} className="flex-grow text-md font-bold bg-transparent border-b-4 border-black focus:outline-none" autoFocus/>
                    ) : (
                        <span className={`text-md font-bold text-gray-900 ${task.completed ? 'line-through' : ''}`}>{task.text}</span>
                    )}
                </div>
                <div className="flex-shrink-0 flex flex-wrap gap-2 items-center justify-between w-full md:w-auto mt-2 md:mt-0">
                    {task.startDate && (<span className="px-2 py-1 text-xs font-bold border-2 border-black bg-gray-200">START: {new Date(task.startDate).toLocaleDateString()}</span>)}
                    {task.dueDate && (<span className={`px-2 py-1 text-xs font-bold border-2 border-black ${isOverdue ? 'bg-red-500 text-black' : 'bg-gray-200 text-gray-700'}`}>DUE: {new Date(task.dueDate).toLocaleDateString()}</span>)}
                    {task.recurrence && (<span className="px-2 py-1 text-xs font-bold border-2 border-black bg-blue-500 text-black">{task.recurrence.toUpperCase()}</span>)}
                    <span className={`px-2 py-1 text-xs font-bold border-2 border-black ${priorityColors[task.priority]}`}>{task.priority.toUpperCase()}</span>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setEditing(true)} className="p-1 text-gray-400 hover:text-blue-500 transition-colors duration-200" disabled={editing}><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
                        <button onClick={handleDelete} className="p-1 text-gray-400 hover:text-red-500 transition-colors duration-200"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg></button>
                    </div>
                </div>
            </div>

            {task.description && <p className="text-sm font-bold text-gray-700 mt-2">{task.description}</p>}

            {hasNestedTasks && (
                <div className="w-full h-2 bg-gray-200 border-2 border-black mt-2">
                    <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${progress}%` }}></div>
                </div>
            )}
            <div className="flex flex-wrap gap-2 mt-2">
                {task.tags?.map((tag, index) => (
                    <span key={index} className="bg-purple-300 text-black text-xs px-3 py-1 font-bold border-2 border-black">#{tag.toUpperCase()}</span>
                ))}
            </div>

            {hasNestedTasks && (
                <div className="mt-4 pl-6 border-l-4 border-black space-y-3">
                    <ul className="space-y-3">
                        {task.subtasks?.map((nestedTask) => (
                            <NestedTaskItem
                                key={nestedTask.id}
                                task={nestedTask}
                                parentIdPath={currentIdPath}
                                dispatch={dispatch}
                            />
                        ))}
                    </ul>
                </div>
            )}

            <div className="mt-4 pl-6 border-l-4 border-black">
                <div className="flex justify-between items-center pr-2 mb-2 cursor-pointer" onClick={() => setShowSubtaskForm(!showSubtaskForm)}>
                    <h4 className="text-sm font-black text-gray-900">ADD SUBTASK</h4>
                    <button className="p-1 border-3 border-black bg-white text-gray-700 neubrutalist-shadow-hover">
                        <svg className={`w-4 h-4 transition-transform duration-300 ${showSubtaskForm ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
                {showSubtaskForm && <SubtaskForm parentIdPath={currentIdPath} dispatch={dispatch} />}
            </div>

        </li>
    );
};


const TodoItem = ({ todo, dispatch, onReorder }) => {
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState(todo.text);
    const [showDetails, setShowDetails] = useState(true);
    const [showSubtaskForm, setShowSubtaskForm] = useState(false);

    // Effect to calculate progress bar for the main task
    const getProgress = (tasks) => {
        let totalTasks = 0;
        let completedTasks = 0;

        const countTasks = (t) => {
            totalTasks++;
            if (t.completed) completedTasks++;
            if (t.subtasks && t.subtasks.length > 0) {
                t.subtasks.forEach(s => countTasks(s));
            }
        };

        if (tasks && tasks.length > 0) {
            tasks.forEach(t => countTasks(t));
        }

        if (totalTasks === 0) return todo.completed ? 100 : 0;
        return Math.round((completedTasks / totalTasks) * 100);
    };

    const progress = getProgress(todo.subtasks);

    const handleToggleTodo = () => {
        dispatch({ type: 'TOGGLE_TODO', payload: { id: todo.id } });
    };

    const handleDeleteTodo = () => {
        dispatch({ type: 'DELETE_TODO', payload: { id: todo.id } });
    };

    const handleEdit = () => {
        if (editText.trim() !== '') {
            dispatch({ type: 'UPDATE_TODO', payload: { id: todo.id, updates: { text: editText } } });
        }
        setEditing(false);
    };

    const handleEditKeyPress = (e) => {
        if (e.key === 'Enter') handleEdit();
    };

    const isOverdue = todo.dueDate && !todo.completed && new Date() > new Date(todo.dueDate);
    const priorityColors = { 'High': 'bg-red-500 text-black', 'Medium': 'bg-yellow-400 text-black', 'Low': 'bg-green-400 text-black' };

    return (
        <li
            draggable="true"
            onDragStart={(e) => {
                e.dataTransfer.setData('todoId', todo.id);
                e.currentTarget.classList.add('opacity-50');
            }}
            onDragEnd={(e) => {
                e.currentTarget.classList.remove('opacity-50');
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
                e.preventDefault();
                const dragId = e.dataTransfer.getData('todoId');
                onReorder(dragId, todo.id);
            }}
            className={`flex flex-col p-3 px-5 border-3 border-black neubrutalist-shadow transition-all duration-300 ${
                todo.completed ? 'bg-gray-300 text-gray-700' : 'bg-white hover:bg-gray-100 neubrutalist-shadow-hover'
            } ${isOverdue ? '!bg-red-200' : ''}`}>
            <div className="flex flex-col md:flex-row items-start md:items-center w-full">
                <div className="flex-grow flex items-center gap-4 mb-2 md:mb-0 w-full">
                    <button onClick={handleToggleTodo} className={`flex-shrink-0 w-5 h-5 border-3 border-black neubrutalist-shadow-hover focus:outline-none transition-all duration-200 ${
                        todo.completed ? 'bg-green-500' : 'bg-white'
                    }`} aria-label={`Toggle todo: ${todo.text}`}>
                        {todo.completed && (<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="mx-auto my-auto"><polyline points="20 6 9 17 4 12" /></svg>)}
                    </button>
                    {editing ? (
                        <input type="text" value={editText} onChange={(e) => setEditText(e.target.value)} onBlur={handleEdit} onKeyPress={handleEditKeyPress} className="flex-grow text-lg font-black bg-transparent border-b-4 border-black focus:outline-none" autoFocus/>
                    ) : (
                        <span className={`text-lg font-black text-gray-900 ${todo.completed ? 'line-through' : ''}`}>{todo.text}</span>
                    )}
                </div>
                <div className="flex-shrink-0 flex flex-wrap gap-2 items-center justify-between w-full md:w-auto mt-2 md:mt-0">
                    {todo.startDate && (<span className="px-2 py-1 text-xs font-bold border-2 border-black bg-gray-200">START: {new Date(todo.startDate).toLocaleDateString()}</span>)}
                    {todo.dueDate && (<span className={`px-2 py-1 text-xs font-bold border-2 border-black ${isOverdue ? 'bg-red-500 text-black' : 'bg-gray-200 text-gray-700'}`}>DUE: {new Date(todo.dueDate).toLocaleDateString()}</span>)}
                    {todo.recurrence && (<span className="px-2 py-1 text-xs font-bold border-2 border-black bg-blue-500 text-black">{todo.recurrence.toUpperCase()}</span>)}
                    <span className={`px-2 py-1 text-xs font-bold border-2 border-black ${priorityColors[todo.priority]}`}>{todo.priority.toUpperCase()}</span>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setEditing(true)} className="p-2 text-gray-400 hover:text-blue-500 transition-colors duration-200" disabled={editing}><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>
                        <button onClick={handleDeleteTodo} className="p-2 text-gray-400 hover:text-red-500 transition-colors duration-200"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg></button>
                    </div>
                    <button onClick={() => setShowDetails(!showDetails)} className="p-2 text-gray-400 hover:text-gray-700 transition-colors duration-200">
                        <svg className={`w-5 h-5 transition-transform duration-300 ${showDetails ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                </div>
            </div>

            {showDetails && (
                <>
                    {todo.description && <p className="text-sm font-bold text-gray-700 mt-2">{todo.description}</p>}

                    {(todo.subtasks && todo.subtasks.length > 0) && (
                        <div className="w-full h-2 bg-gray-200 border-2 border-black mt-2">
                            <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${progress}%` }}></div>
                        </div>
                    )}
                    <div className="flex flex-wrap gap-2 mt-2">
                        {todo.tags?.map((tag, index) => (
                            <span key={index} className="bg-purple-300 text-black text-xs px-3 py-1 font-bold border-2 border-black">#{tag.toUpperCase()}</span>
                        ))}
                    </div>

                    <div className="mt-4 pl-8 border-l-4 border-black space-y-3">
                        <div className="flex justify-between items-center pr-2">
                            <h4 className="text-sm font-black text-gray-900">SUBTASKS:</h4>
                        </div>
                        <ul className="space-y-3">
                            {todo.subtasks?.map((subtask) => (
                                <NestedTaskItem
                                    key={subtask.id}
                                    task={subtask}
                                    parentIdPath={[todo.id]}
                                    dispatch={dispatch}
                                />
                            ))}
                        </ul>
                        <div className="flex justify-between items-center pr-2 mb-2 cursor-pointer" onClick={() => setShowSubtaskForm(!showSubtaskForm)}>
                            <h4 className="text-sm font-black text-gray-900">ADD SUBTASK</h4>
                            <button className="p-1 border-3 border-black bg-white text-gray-700 neubrutalist-shadow-hover">
                                <svg className={`w-4 h-4 transition-transform duration-300 ${showSubtaskForm ? 'rotate-180' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                            </button>
                        </div>
                        {showSubtaskForm && <SubtaskForm parentIdPath={[todo.id]} dispatch={dispatch} />}
                    </div>
                </>
            )}
        </li>
    );
};

export const TitleBar = ({ appName }) => (
    <div data-tauri-drag-region className={"bg-blue-600 z-100 p-2 flex items-center w-full justify-between gap-2 border-y-3 fixed"}>
        <span data-tauri-drag-region className="text-black font-extrabold text-sm">{appName}</span>
        <div data-tauri-drag-region className="flex items-center  gap-2">
            <div onClick={()=>webviewWindow.getCurrentWebviewWindow().minimize()} className={"px-1 w-7 aspect-square py-1 text-sm rounded-full font-bold bg-gray-100 text-black border-3 border-black neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover"}></div>
            <div onClick={()=>webviewWindow.getCurrentWebviewWindow().toggleMaximize()} className={"px-1 w-7 aspect-square py-1 text-sm rounded-full font-bold bg-gray-100 text-black border-3 border-black neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover"}></div>
            <div onClick={()=>webviewWindow.getCurrentWebviewWindow().close()} className={"px-1 w-7 aspect-square py-1 text-sm rounded-full font-bold bg-pink-600 text-black border-3 border-black neubrutalist-shadow transition-all duration-100 ease-in-out neubrutalist-shadow-hover"}></div>
        </div>
    </div>
);
